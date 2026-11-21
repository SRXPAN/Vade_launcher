import { describe, expect, it } from 'vitest';
import {
  buildAgentConfig,
  defaultSettings,
  deriveDisplayStatus,
  hostsInCidr,
  lastOccurrence,
  nextOccurrence,
  normalizeMac,
  occurrenceKey,
  parseAppIds,
  parseCidr,
  pcRunTime,
  SEED_PCS,
  validatePc,
  type PcRuntime,
} from '../src/index';
import { agentProof, authMac, newClubKey, safeEqual, seal, sessionKey, unseal } from '../src/auth';

describe('schedule', () => {
  const s = { startTime: '11:00', stepMin: 1 };
  it('uses the .bat formula start + (id-1)*step', () => {
    expect(pcRunTime(s, 1)).toBe('11:00');
    expect(pcRunTime(s, 29)).toBe('11:28');
    expect(pcRunTime({ startTime: '23:50', stepMin: 2 }, 10)).toBe('00:08');
  });
  it('finds last and next occurrences', () => {
    const now = new Date(2026, 10, 21, 10, 0, 0);
    expect(occurrenceKey(lastOccurrence(660, now))).toBe('2026-11-20');
    expect(nextOccurrence(660, now).getHours()).toBe(11);
    expect(occurrenceKey(nextOccurrence(660, now))).toBe('2026-11-21');
    const after = new Date(2026, 10, 21, 11, 0, 0);
    expect(occurrenceKey(lastOccurrence(660, after))).toBe('2026-11-21');
  });
});

describe('validation', () => {
  it('normalises MAC addresses', () => {
    expect(normalizeMac('30-56-0F-3E-93-88')).toBe('30:56:0f:3e:93:88');
    expect(normalizeMac('30560f3e9388')).toBe('30:56:0f:3e:93:88');
    expect(normalizeMac('30:56:0f:3e:93')).toBeNull();
    expect(normalizeMac('zz:56:0f:3e:93:88')).toBeNull();
  });
  it('parses the club subnet', () => {
    const c = parseCidr('10.70.4.0/24')!;
    expect(c.prefix).toBe(24);
    const hosts = hostsInCidr('10.70.4.0/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('10.70.4.1');
    expect(hosts.at(-1)).toBe('10.70.4.254');
  });
  it('parses AppID lists', () => {
    expect(parseAppIds('730, 570 578080;730')).toEqual([730, 570, 578080]);
    expect(parseAppIds('730 abc')).toBeNull();
    expect(parseAppIds('')).toEqual([]);
  });
  it('validates PCs against duplicates', () => {
    const errs = validatePc({ id: 2, ip: '10.70.4.112', mac: '30:56:0f:3e:93:88', zone: 'Regular' }, SEED_PCS, null);
    expect(errs.join(' ')).toMatch(/ПК №2 уже існує/);
    expect(errs.join(' ')).toMatch(/10\.70\.4\.112/);
    expect(validatePc({ ...SEED_PCS[0] }, SEED_PCS, 1)).toEqual([]);
  });
  it('seed data is consistent', () => {
    for (const pc of SEED_PCS) expect(validatePc(pc, SEED_PCS, pc.id)).toEqual([]);
    expect(SEED_PCS.filter((p) => p.zone === 'Stream').map((p) => p.id)).toEqual([18, 19]);
  });
});

describe('agent config', () => {
  it('applies per-PC overrides and has a stable revision', () => {
    const settings = defaultSettings('k');
    const pc = { ...SEED_PCS[0], overrides: { afterAction: 'shutdown' as const, updateAppIds: [730] } };
    const a = buildAgentConfig(settings, pc);
    expect(a.maintenance.after.action).toBe('shutdown');
    expect(a.maintenance.update).toMatchObject({ mode: 'list', appIds: [730] });
    expect(a.schedule.runTime).toBe('11:00');
    expect(buildAgentConfig(settings, pc).rev).toBe(a.rev);
    expect(buildAgentConfig(settings, { ...pc, overrides: { scheduleEnabled: false } }).schedule.enabled).toBe(false);
    expect(settings.maintenance.after.action).toBe('hibernate'); // global settings untouched
  });
});

describe('display status', () => {
  const base: PcRuntime = { pcId: 1, link: 'offline', info: null, status: null, sleeping: false, lastSeen: null, lastError: null, wolSentAt: null };
  it('maps link + agent state', () => {
    expect(deriveDisplayStatus(base)).toBe('offline');
    expect(deriveDisplayStatus({ ...base, sleeping: true })).toBe('sleeping');
    expect(deriveDisplayStatus({ ...base, link: 'auth-failed' })).toBe('error');
    const status = { state: 'updating', job: null, lastJob: null, nextRunAt: null, pendingPower: null, configRev: null, steamcmdInstalled: true, dryRun: false } as const;
    expect(deriveDisplayStatus({ ...base, link: 'online', status })).toBe('updating');
  });
});

describe('auth', () => {
  it('verifies both sides and seals secrets', () => {
    const key = newClubKey();
    const a = 'agent-nonce';
    const b = 'admin-nonce';
    expect(safeEqual(authMac(key, a, b), authMac(key, a, b))).toBe(true);
    expect(safeEqual(authMac(key, a, b), authMac('other', a, b))).toBe(false);
    expect(agentProof(key, a, b)).not.toBe(authMac(key, a, b));
    const k1 = sessionKey(key, a, b);
    const sealed = seal(k1, 'пароль-123');
    expect(sealed.ct).not.toContain('123');
    expect(unseal(sessionKey(key, a, b), sealed)).toBe('пароль-123');
    expect(() => unseal(sessionKey(key, a, 'x'), sealed)).toThrow();
  });
});
