import { describe, expect, it } from 'vitest';
import {
  buildAgentConfig,
  clockDriftSec,
  DEFAULT_ALERTS,
  defaultSettings,
  deriveDisplayStatus,
  evaluateHealth,
  formatClockDrift,
  hostsInCidr,
  isClockDrifted,
  lastOccurrence,
  nextOccurrence,
  normalizeMac,
  occurrenceKey,
  parseAppIds,
  parseCidr,
  pcRunTime,
  resolveHealthThresholds,
  SEED_PCS,
  validatePc,
  worstHealthLevel,
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
    expect(settings.maintenance.update.ignoreAppIds).toEqual([]);
    expect(settings.maintenance.update.treatNoSubscriptionAsError).toBe(false);
    const pc = { ...SEED_PCS[0], overrides: { afterAction: 'shutdown' as const, updateAppIds: [730] } };
    const a = buildAgentConfig(settings, pc);
    expect(a.maintenance.after.action).toBe('shutdown');
    expect(a.maintenance.update).toMatchObject({ mode: 'list', appIds: [730], ignoreAppIds: [], treatNoSubscriptionAsError: false });
    expect(a.schedule.runTime).toBe('11:00');
    expect(buildAgentConfig(settings, pc).rev).toBe(a.rev);
    expect(buildAgentConfig(settings, { ...pc, overrides: { scheduleEnabled: false } }).schedule.enabled).toBe(false);
    expect(settings.maintenance.after.action).toBe('hibernate'); // global settings untouched

    // Changing ignoreAppIds or treatNoSubscriptionAsError bumps config rev so agents pick it up
    const withIgnore = structuredClone(settings);
    withIgnore.maintenance.update.ignoreAppIds = [1422450];
    const b = buildAgentConfig(withIgnore, SEED_PCS[0]);
    expect(b.maintenance.update.ignoreAppIds).toEqual([1422450]);
    expect(b.rev).not.toBe(buildAgentConfig(settings, SEED_PCS[0]).rev);

    const withStrict = structuredClone(settings);
    withStrict.maintenance.update.treatNoSubscriptionAsError = true;
    expect(buildAgentConfig(withStrict, SEED_PCS[0]).rev).not.toBe(buildAgentConfig(settings, SEED_PCS[0]).rev);
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
    // Ignored / skipped_no_subscription apps with result 'ok' keep PC Online (not Error)
    expect(
      deriveDisplayStatus({
        ...base,
        link: 'online',
        status: {
          ...status,
          state: 'idle',
          lastJob: {
            id: 'j1',
            mode: 'scheduled',
            startedAt: '2026-01-01T00:00:00Z',
            finishedAt: '2026-01-01T00:05:00Z',
            steps: [],
            apps: [
              { appId: 730, library: 'C:\\Steam', status: 'ok' },
              { appId: 1422450, library: 'C:\\Steam', status: 'ignored' },
              { appId: 578080, library: 'C:\\Steam', status: 'skipped_no_subscription' },
            ],
            progress: null,
            errors: 0,
            result: 'ok',
          },
        },
      }),
    ).toBe('online');
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

describe('hardware health thresholds', () => {
  it('detects RAM, monitor Hz, GPU temp, SSD wear and unhealthy SMART status with zone overrides', () => {
    expect(evaluateHealth(null, DEFAULT_ALERTS)).toEqual([]);
    expect(evaluateHealth(undefined, DEFAULT_ALERTS)).toEqual([]);

    const healthy = {
      ramTotalGb: 32,
      refreshRateHz: 240,
      gpuTempC: 65,
      cpuTempC: null,
      ssd: [{ model: 'Samsung 980', healthStatus: 'Healthy', wearPct: 12, tempC: 42 }],
    };
    expect(evaluateHealth(healthy, DEFAULT_ALERTS, 'Regular')).toEqual([]);
    expect(worstHealthLevel(healthy, DEFAULT_ALERTS, 'Regular')).toBe('ok');

    // Low refresh rate -> warn
    const lowHz = { ...healthy, refreshRateHz: 60 };
    expect(evaluateHealth(lowHz, DEFAULT_ALERTS)).toMatchObject([{ kind: 'refreshRate', level: 'warn' }]);
    expect(worstHealthLevel(lowHz, DEFAULT_ALERTS)).toBe('warn');

    // Missing RAM stick (16 GB < 32 GB) -> crit
    const lowRam = { ...healthy, ramTotalGb: 16 };
    expect(evaluateHealth(lowRam, DEFAULT_ALERTS)).toMatchObject([{ kind: 'ram', level: 'crit' }]);
    expect(worstHealthLevel(lowRam, DEFAULT_ALERTS)).toBe('crit');

    // Hot GPU & high SSD wear
    const hot = {
      ...healthy,
      gpuTempC: 88,
      ssd: [{ model: 'WD', healthStatus: 'Healthy', wearPct: 82, tempC: 55 }],
    };
    expect(evaluateHealth(hot, DEFAULT_ALERTS).map((i) => i.kind)).toEqual(['gpuTemp', 'ssdWear']);
    expect(worstHealthLevel(hot, DEFAULT_ALERTS)).toBe('warn');

    // Unhealthy SMART -> crit
    const badSsd = {
      ...healthy,
      ssd: [{ model: 'Kingston', healthStatus: 'Warning', wearPct: 50, tempC: 40 }],
    };
    expect(worstHealthLevel(badSsd, DEFAULT_ALERTS)).toBe('crit');

    // Zone override: Stream requires 360 Hz & 64 GB RAM
    const withZones = {
      ...DEFAULT_ALERTS,
      zoneThresholds: { Stream: { minRamGb: 64, minRefreshRateHz: 360 } },
    };
    expect(resolveHealthThresholds(withZones, 'Stream')).toMatchObject({ minRamGb: 64, minRefreshRateHz: 360, maxGpuTempC: 85 });
    expect(worstHealthLevel(healthy, withZones, 'Stream')).toBe('crit');
    expect(worstHealthLevel(healthy, withZones, 'Regular')).toBe('ok');
  });
});

describe('clock drift detection', () => {
  it('flags drift only when abs(agentTimeMs - nowMs) exceeds 120 seconds', () => {
    const now = 1_700_000_000_000;
    expect(isClockDrifted(undefined, now)).toBe(false);
    expect(isClockDrifted(now + 120_000, now)).toBe(false);
    expect(isClockDrifted(now - 120_000, now)).toBe(false);
    expect(isClockDrifted(now + 121_000, now)).toBe(true);
    expect(isClockDrifted(now - 300_000, now)).toBe(true);
    expect(clockDriftSec(now + 300_000, now)).toBe(300);
    expect(formatClockDrift(300)).toBe('+5 хв');
    expect(formatClockDrift(-180)).toBe('−3 хв');
  });
});
