import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@vade/protocol';
import { AUDIT_MAX_ENTRIES, AUDIT_RETENTION_DAYS, AuditStore, pruneAudit } from '../src/main/audit';
import {
  isFeatureAllowed,
  requiresOwnerForAction,
  RoleController,
  type ProtectedFeature,
} from '../src/shared/access';
import type { PcAction } from '../src/shared/api';

const DAY_MS = 86_400_000;
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-access-audit-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const PROTECTED_FEATURES: ProtectedFeature[] = [
  'map.edit',
  'pc.edit',
  'settings.edit',
  'deploy',
  'agent.update',
  'backup',
  'power.occupied',
];

describe('Module 1: Access rules (isFeatureAllowed & requiresOwnerForAction)', () => {
  it('allows all protected features when PIN is disabled or role is owner, blocks operator when PIN is enabled', () => {
    for (const f of PROTECTED_FEATURES) {
      expect(isFeatureAllowed('operator', false, f)).toBe(true);
      expect(isFeatureAllowed('owner', false, f)).toBe(true);
      expect(isFeatureAllowed('operator', true, f)).toBe(false);
      expect(isFeatureAllowed('owner', true, f)).toBe(true);
    }
  });

  it('requires owner only for operator with PIN enabled on occupied PCs for disruptive/forced actions', () => {
    const disruptive: PcAction[] = ['shutdown', 'restart', 'sleep', 'hibernate', 'test', 'run', 'clean-logins'];
    const nonDisruptive: PcAction[] = ['wake', 'cancel', 'cancel-power', 'sync-time'];

    for (const action of [...disruptive, ...nonDisruptive]) {
      // PIN disabled -> never blocked
      expect(requiresOwnerForAction({ pinEnabled: false, role: 'operator', action, occupiedCount: 3, force: true })).toBe(false);
      // Owner -> never blocked
      expect(requiresOwnerForAction({ pinEnabled: true, role: 'owner', action, occupiedCount: 3, force: true })).toBe(false);
      // Free PCs (occupiedCount === 0) -> never blocked
      expect(requiresOwnerForAction({ pinEnabled: true, role: 'operator', action, occupiedCount: 0, force: true })).toBe(false);
    }

    for (const action of disruptive) {
      expect(requiresOwnerForAction({ pinEnabled: true, role: 'operator', action, occupiedCount: 1 })).toBe(true);
    }
    for (const action of nonDisruptive) {
      expect(requiresOwnerForAction({ pinEnabled: true, role: 'operator', action, occupiedCount: 2 })).toBe(false);
      expect(requiresOwnerForAction({ pinEnabled: true, role: 'operator', action, occupiedCount: 2, force: true })).toBe(true);
    }
  });
});

describe('Module 1: RoleController state machine', () => {
  it('starts in operator mode when PIN is enabled and owner mode when PIN is disabled', () => {
    let pinEnabled = true;
    const rc = new RoleController({
      isPinEnabled: () => pinEnabled,
      verifyPin: (p) => p === '1234',
      getSessionMin: () => 20,
      initialOperatorName: '  Alex  ',
    });

    expect(rc.state()).toEqual({
      pinEnabled: true,
      role: 'operator',
      unlockedUntil: null,
      ownerSessionMin: 20,
      operatorName: 'Alex',
    });

    pinEnabled = false;
    expect(rc.syncPinConfig()).toMatchObject({
      pinEnabled: false,
      role: 'owner',
      unlockedUntil: null,
    });
    rc.stop();
  });

  it('rejects wrong PIN, unlocks with valid PIN, auto-locks on fake-timer expiry, and audits events', () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-11-23T10:00:00.000Z');
    vi.setSystemTime(t0);

    const audits: Array<{ action: 'role.unlock' | 'role.lock'; details?: string }> = [];
    const changes: string[] = [];

    const rc = new RoleController({
      isPinEnabled: () => true,
      verifyPin: (p) => p === '7777',
      getSessionMin: () => 15,
      onAudit: (action, details) => audits.push({ action, details }),
    });
    rc.on('changed', (s) => changes.push(s.role));

    // Wrong PIN
    const bad = rc.unlock('0000');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('Невірний PIN-код');
    expect(bad.state.role).toBe('operator');
    expect(changes).toEqual([]);
    expect(audits).toEqual([]);

    // Valid PIN
    const good = rc.unlock('7777');
    expect(good.ok).toBe(true);
    expect(good.state.role).toBe('owner');
    expect(good.state.unlockedUntil).toBe(t0 + 15 * 60_000);
    expect(changes).toEqual(['owner']);
    expect(audits).toEqual([{ action: 'role.unlock', details: '15 min' }]);

    // Still owner 1 ms before expiry
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(rc.state().role).toBe('owner');

    // Auto-locks on timeout
    vi.advanceTimersByTime(1);
    expect(rc.state()).toMatchObject({ role: 'operator', unlockedUntil: null });
    expect(changes).toEqual(['owner', 'operator']);
    expect(audits).toEqual([
      { action: 'role.unlock', details: '15 min' },
      { action: 'role.lock', details: 'timeout' },
    ]);
  });

  it('clamps session duration between 1 and 240 minutes and supports manual lock without duplicate audit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    let sessionMin = 0;
    const audits: Array<{ action: 'role.unlock' | 'role.lock'; details?: string }> = [];
    const rc = new RoleController({
      isPinEnabled: () => true,
      verifyPin: () => true,
      getSessionMin: () => sessionMin,
      onAudit: (action, details) => audits.push({ action, details }),
    });

    const minRes = rc.unlock('1234');
    expect(minRes.state.ownerSessionMin).toBe(1);
    expect(minRes.state.unlockedUntil).toBe(1_000_000 + 60_000);

    sessionMin = 999;
    const maxRes = rc.unlock('1234');
    expect(maxRes.state.ownerSessionMin).toBe(240);
    expect(maxRes.state.unlockedUntil).toBe(1_000_000 + 240 * 60_000);

    // Manual lock clears timer and audits once
    const locked = rc.lock('manual');
    expect(locked.role).toBe('operator');
    expect(locked.unlockedUntil).toBeNull();
    // Advancing timers past original 240 min does not fire timeout audit
    vi.advanceTimersByTime(250 * 60_000);
    // Repeated lock when already locked does not audit
    rc.lock('extra');

    expect(audits).toEqual([
      { action: 'role.unlock', details: '1 min' },
      { action: 'role.unlock', details: '240 min' },
      { action: 'role.lock', details: 'manual' },
    ]);
  });

  it('handles lazy expiry via now(), setOperatorName, syncPinConfig, requireOwner, and stop()', () => {
    vi.useFakeTimers();
    let currentNow = 500_000;
    let pinEnabled = false;
    let savedName = '';
    const audits: Array<'role.unlock' | 'role.lock'> = [];

    const rc = new RoleController({
      isPinEnabled: () => pinEnabled,
      verifyPin: (p) => p === '4321',
      getSessionMin: () => 5,
      onOperatorNameSaved: (name) => {
        savedName = name;
      },
      onAudit: (action) => audits.push(action),
      now: () => currentNow,
    });

    // Disabled PIN allows requireOwner
    expect(() => rc.requireOwner('settings.edit')).not.toThrow();

    // Operator name trimmed & capped to 60 chars
    const longName = `   ${'A'.repeat(75)}   `;
    const nameState = rc.setOperatorName(longName);
    expect(nameState.operatorName).toBe('A'.repeat(60));
    expect(savedName).toBe('A'.repeat(60));

    // Newly enabling PIN puts controller into operator mode
    pinEnabled = true;
    expect(rc.syncPinConfig().role).toBe('operator');
    expect(() => rc.requireOwner('deploy')).toThrow('Потрібен режим «Власник» (введіть PIN-код)');

    // Unlock, then check requireOwner passes, then advance custom clock past unlockedUntil
    rc.unlock('4321');
    expect(() => rc.requireOwner('deploy')).not.toThrow();
    currentNow += 5 * 60_000;
    expect(rc.state().role).toBe('operator');
    expect(() => rc.requireOwner('map.edit')).toThrow('Потрібен режим «Власник» (введіть PIN-код)');

    // Disabling PIN while unlocked clears unlockedUntil so re-enabling starts locked
    currentNow = 500_000;
    rc.unlock('4321');
    pinEnabled = false;
    expect(rc.syncPinConfig().role).toBe('owner');
    pinEnabled = true;
    expect(rc.syncPinConfig().role).toBe('operator');

    // stop() cancels timer cleanly
    rc.unlock('4321');
    const auditCountBeforeStop = audits.length;
    rc.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(audits).toHaveLength(auditCountBeforeStop);
  });
});

describe('Module 2: AuditStore & pruneAudit', () => {
  it('exports 30-day retention and 5000-entry cap defaults and prunes/sorts cleanly', () => {
    expect(AUDIT_RETENTION_DAYS).toBe(30);
    expect(AUDIT_MAX_ENTRIES).toBe(5000);

    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const entries: AuditEntry[] = [
      { id: 'too-old', ts: new Date(now - 31 * DAY_MS).toISOString(), role: 'operator', action: 'pc.wol', targets: ['1'] },
      { id: 'bad-ts', ts: 'not-a-date', role: 'operator', action: 'pc.wol', targets: ['1'] },
      { id: 'older', ts: new Date(now - 5 * DAY_MS).toISOString(), role: 'operator', action: 'pc.wol', targets: ['2'] },
      { id: 'newest', ts: new Date(now - 1000).toISOString(), role: 'owner', action: 'settings.save', targets: [] },
    ];

    expect(pruneAudit(entries, 30, 5000, now).map((e) => e.id)).toEqual(['newest', 'older']);

    // Cap at 5000 entries keeping newest
    const many: AuditEntry[] = Array.from({ length: 5005 }, (_, i) => ({
      id: `e-${i}`,
      ts: new Date(now - i * 1000).toISOString(),
      role: 'operator',
      action: 'pc.wol',
      targets: [String(i + 1)],
    }));
    const capped = pruneAudit(many, 30, 5000, now);
    expect(capped).toHaveLength(5000);
    expect(capped[0].id).toBe('e-0');
    expect(capped[4999].id).toBe('e-4999');
  });

  it('persists atomically, emits changed, reloads, and caps at 5000 entries', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'audit.json');
    const store = new AuditStore(file);
    const events: number[] = [];
    store.on('changed', (list) => events.push(list.length));

    const t1 = Date.now() - 10_000;
    const t2 = Date.now() - 5_000;

    const e1 = store.record(
      {
        role: 'operator',
        operatorName: '  Ivan  ',
        action: 'pc.wol',
        targets: [1, 2],
        details: '  Wake lobby PCs  ',
      },
      t1,
    );
    expect(e1.id).toBeTruthy();
    expect(e1.ts).toBe(new Date(t1).toISOString());
    expect(e1.operatorName).toBe('Ivan');
    expect(e1.targets).toEqual(['1', '2']);
    expect(e1.details).toBe('Wake lobby PCs');

    const e2 = store.record(
      {
        role: 'owner',
        operatorName: '   ',
        action: 'settings.save',
        targets: ['club'],
      },
      t2,
    );
    expect(e2.operatorName).toBeUndefined();
    expect(events).toEqual([1, 2]);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.bak`)).toBe(true);

    const reloaded = new AuditStore(file);
    expect(reloaded.list().map((e) => e.id)).toEqual([e2.id, e1.id]);

    // Verify 5000-entry cap on disk reload
    const now = Date.now();
    const bulk: AuditEntry[] = Array.from({ length: 5005 }, (_, i) => ({
      id: `bulk-${i}`,
      ts: new Date(now - i * 1000).toISOString(),
      role: 'operator',
      action: 'pc.clean',
      targets: ['1'],
    }));
    fs.writeFileSync(file, JSON.stringify(bulk));
    const cappedStore = new AuditStore(file);
    expect(cappedStore.list()).toHaveLength(5000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(5000);
  });

  it('recovers from .bak when main file is corrupt and prunes expired entries on startup', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'audit.json');
    const now = Date.now();

    const validEntry: AuditEntry = {
      id: 'bak-1',
      ts: new Date(now - 60_000).toISOString(),
      role: 'owner',
      operatorName: 'Boss',
      action: 'role.unlock',
      targets: [],
      details: '20 min',
    };
    const expiredEntry: AuditEntry = {
      id: 'expired-1',
      ts: new Date(now - 45 * DAY_MS).toISOString(),
      role: 'operator',
      action: 'pc.wol',
      targets: ['5'],
    };

    fs.writeFileSync(`${file}.bak`, JSON.stringify([validEntry, expiredEntry]));
    fs.writeFileSync(file, '{corrupt json!!!');

    const recovered = new AuditStore(file);
    expect(recovered.list()).toEqual([validEntry]);
    // Main file was healed on disk
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([validEntry]);
  });
});
