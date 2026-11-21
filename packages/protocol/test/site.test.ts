import { describe, expect, it } from 'vitest';
import {
  buildAgentConfig,
  buildSitePayload,
  compareVersions,
  defaultSettings,
  diskLevel,
  formatGb,
  orderQueue,
  parseNameList,
  publicPcStatus,
  SEED_PCS,
  sitePayloadSignature,
  worstDiskLevel,
  type AgentStatus,
  type PcRuntime,
} from '../src/index';

const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  state: 'idle',
  job: null,
  lastJob: null,
  nextRunAt: null,
  pendingPower: null,
  configRev: null,
  steamcmdInstalled: true,
  dryRun: false,
  occupancy: 'free',
  ...over,
});
const rt = (over: Partial<PcRuntime> = {}): PcRuntime => ({
  pcId: 1,
  link: 'online',
  info: null,
  status: status(),
  sleeping: false,
  lastSeen: null,
  lastError: null,
  wolSentAt: null,
  ...over,
});

describe('public status for the website', () => {
  it('maps the runtime to free / occupied / maintenance / offline', () => {
    expect(publicPcStatus(undefined)).toBe('offline');
    expect(publicPcStatus(rt({ link: 'offline' }))).toBe('offline');
    expect(publicPcStatus(rt({ link: 'auth-failed' }))).toBe('offline');
    expect(publicPcStatus(rt())).toBe('free');
    expect(publicPcStatus(rt({ status: status({ occupancy: 'occupied' }) }))).toBe('occupied');
    expect(publicPcStatus(rt({ status: status({ state: 'updating', occupancy: 'occupied' }) }))).toBe('maintenance');
    expect(publicPcStatus(rt({ status: status({ state: 'steam-login' }) }))).toBe('maintenance');
    // unknown never advertises a seat as free
    expect(publicPcStatus(rt({ status: status({ occupancy: 'unknown' }) }))).toBe('occupied');
    expect(publicPcStatus(rt({ status: status({ occupancy: undefined }) }))).toBe('occupied');
  });

  it('builds a payload without any private data', () => {
    const pcs = [{ ...SEED_PCS[1], name: 'Біля вікна' }, SEED_PCS[0], SEED_PCS[13]];
    const p = buildSitePayload(pcs, (id) => (id === 1 ? rt({ status: status({ occupancy: 'occupied' }) }) : undefined), new Date('2026-11-21T14:30:00Z'));
    expect(p).toEqual({
      updatedAt: '2026-11-21T14:30:00.000Z',
      pcs: [
        { id: 1, zone: 'Regular', status: 'occupied' },
        { id: 2, zone: 'Regular', status: 'offline' },
        { id: 18, zone: 'Stream', status: 'offline' },
      ],
    });
    const json = JSON.stringify(p);
    for (const secret of ['10.70.4.', '30:56:0f', 'Біля вікна', 'mac', 'ip']) expect(json).not.toContain(secret);
  });

  it('signature ignores the timestamp', () => {
    const a = buildSitePayload(SEED_PCS, () => undefined, new Date(1));
    const b = buildSitePayload(SEED_PCS, () => undefined, new Date(2));
    expect(sitePayloadSignature(a)).toBe(sitePayloadSignature(b));
    const c = buildSitePayload(SEED_PCS, (id) => (id === 5 ? rt() : undefined), new Date(2));
    expect(sitePayloadSignature(c)).not.toBe(sitePayloadSignature(a));
  });
});

describe('disks, versions, queue order', () => {
  const GB = 1024 ** 3;
  const alerts = { diskWarnGb: 30, diskCritGb: 15 };
  it('disk thresholds: yellow below warn, red below crit', () => {
    expect(diskLevel(42 * GB, alerts)).toBe('ok');
    expect(diskLevel(30 * GB, alerts)).toBe('ok');
    expect(diskLevel(29.9 * GB, alerts)).toBe('warn');
    expect(diskLevel(15 * GB, alerts)).toBe('warn');
    expect(diskLevel(14.9 * GB, alerts)).toBe('crit');
    expect(worstDiskLevel([{ drive: 'C:', freeBytes: 42 * GB, totalBytes: 1 }, { drive: 'D:', freeBytes: 18 * GB, totalBytes: 1 }], alerts)).toBe('warn');
    expect(worstDiskLevel([{ drive: 'C:', freeBytes: 2 * GB, totalBytes: 1 }], alerts)).toBe('crit');
    expect(worstDiskLevel(undefined, alerts)).toBe('ok');
    expect(formatGb(42.7 * GB)).toBe('42 GB');
    expect(formatGb(7.44 * GB)).toBe('7.4 GB');
  });
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.3.0', '0.3')).toBe(0);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
  });
  it('orders the queue by zone priority, then by PC number', () => {
    expect(orderQueue(SEED_PCS, ['Stream']).slice(0, 4).map((p) => p.id)).toEqual([18, 19, 1, 2]);
    expect(orderQueue(SEED_PCS, []).map((p) => p.id)).toEqual(SEED_PCS.map((p) => p.id));
  });
  it('queue mode switches the agents own night timer off', () => {
    const s = defaultSettings('k');
    expect(buildAgentConfig(s, SEED_PCS[0]).schedule.enabled).toBe(true);
    s.schedule.mode = 'queue';
    expect(buildAgentConfig(s, SEED_PCS[0]).schedule.enabled).toBe(false);
    expect(buildAgentConfig(s, SEED_PCS[0]).postSessionClean).toMatchObject({ enabled: true, delaySec: 45, cleanSteamLogins: true });
  });
});

describe('settings helpers', () => {
  it('parses name lists', () => {
    expect(parseNameList('cs2.exe\n dota2.exe, CS2.exe;\n\nTslGame.exe')).toEqual(['cs2.exe', 'dota2.exe', 'TslGame.exe']);
  });
  it('sends the detector to agents and defaults are budget friendly', () => {
    const s = defaultSettings('k');
    expect(s.maintenance.skipIfOccupied).toBe(true);
    expect(s.site).toMatchObject({ enabled: false, heartbeatSec: 600, debounceSec: 2, dailyLimit: 900 });
    expect(86_400 / s.site.heartbeatSec).toBeLessThan(s.site.dailyLimit);
    const cfg = buildAgentConfig(s, SEED_PCS[0]);
    expect(cfg.detector.gameProcesses).toContain('cs2.exe');
    expect(cfg.detector.idleMinutes).toBe(10);
  });
});
