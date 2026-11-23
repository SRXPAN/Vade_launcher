import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAgentConfig,
  DEFAULT_HEALTH_TELEMETRY,
  defaultSettings,
  SEED_PCS,
  type DiagRestartLauncherArgs,
} from '@vade/protocol';
import { Agent, effectiveHealth, validateConfigPayload } from '../src/agent';
import { Logger } from '../src/logger';
import { AgentStore } from '../src/store';
import { Sys } from '../src/sys';
import {
  restartUserLauncher,
  restoreMonitorRefreshRate,
  sendUserMessage,
} from '../src/win/diagnostics';

let tmp: string;
let log: Logger;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-ops-diag-'));
  log = new Logger(path.join(tmp, 'logs'), false);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Module 5: Quick Tech Agent Commands', () => {
  it('validates sendUserMessage and returns dry-run result without blocking', async () => {
    const sys = new Sys(true, log);
    await expect(sendUserMessage(sys, log, { title: 'Notice', message: '' })).rejects.toThrow();
    await expect(sendUserMessage(sys, log, { title: 'Notice', message: '   \n\t  ' })).rejects.toThrow();

    const resDefaultTitle = await sendUserMessage(sys, log, { title: '  ', message: 'Підійдіть на рецепцію', timeoutSec: 999 });
    expect(resDefaultTitle.ok).toBe(true);
    expect(resDefaultTitle.message).toContain('[dry-run]');
    expect(resDefaultTitle.message).toContain('Vade Launcher');

    const resCustomTitle = await sendUserMessage(sys, log, { title: 'Адміністратор', message: 'Технічна перерва через 5 хв', timeoutSec: 2 });
    expect(resCustomTitle.ok).toBe(true);
    expect(resCustomTitle.message).toContain('[dry-run]');
    expect(resCustomTitle.message).toContain('Адміністратор');
  });

  it('validates restoreMonitorRefreshRate range and returns dry-run result', async () => {
    const sys = new Sys(true, log);
    const presenceDir = path.join(tmp, 'presence');

    await expect(restoreMonitorRefreshRate(sys, log, presenceDir, 49)).rejects.toThrow();
    await expect(restoreMonitorRefreshRate(sys, log, presenceDir, 601)).rejects.toThrow();
    await expect(restoreMonitorRefreshRate(sys, log, presenceDir, 144.5)).rejects.toThrow();
    await expect(restoreMonitorRefreshRate(sys, log, presenceDir, Number.NaN)).rejects.toThrow();

    const res = await restoreMonitorRefreshRate(sys, log, presenceDir, 240);
    expect(res).toEqual({
      ok: true,
      message: '[dry-run] Частоту монітора встановлено: 240 Гц',
    });
  });

  it('validates restartUserLauncher app, returns dry-run result, and reports missing executable', async () => {
    const drySys = new Sys(true, log);
    await expect(
      restartUserLauncher(drySys, log, { app: 'epic' } as unknown as DiagRestartLauncherArgs, 'C:\\Steam'),
    ).rejects.toThrow();

    const steamRes = await restartUserLauncher(drySys, log, { app: 'steam' }, 'C:\\Program Files (x86)\\Steam');
    expect(steamRes).toEqual({ ok: true, message: '[dry-run] Перезапущено Steam' });

    const riotRes = await restartUserLauncher(drySys, log, { app: 'riot' }, 'C:\\Program Files (x86)\\Steam', [
      { id: 'riot', name: 'Riot Client', exePath: 'D:\\Riot\\RiotClientServices.exe', enabled: true },
    ]);
    expect(riotRes).toEqual({ ok: true, message: '[dry-run] Перезапущено Riot Client' });

    const realSys = new Sys(false, log);
    const missingPath = path.join(tmp, 'MissingSteam');
    const missingRes = await restartUserLauncher(realSys, log, { app: 'steam' }, missingPath);
    expect(missingRes.ok).toBe(false);
    expect(missingRes.message).toContain('Не знайдено файл');
  });
});

describe('Module 5: effectiveHealth & validateConfigPayload health validation', () => {
  it('returns defaults when health is omitted and clamps pollIntervalSec to 30..600', () => {
    expect(effectiveHealth(null)).toEqual(DEFAULT_HEALTH_TELEMETRY);

    const base = buildAgentConfig(defaultSettings('k'), SEED_PCS[0]);
    expect(effectiveHealth({ ...base, health: undefined })).toEqual(DEFAULT_HEALTH_TELEMETRY);

    expect(
      effectiveHealth({
        ...base,
        health: { enabled: false, pollIntervalSec: 5, collectTemps: false, collectSmart: true },
      }),
    ).toEqual({
      enabled: false,
      pollIntervalSec: 30,
      collectTemps: false,
      collectSmart: true,
    });

    expect(
      effectiveHealth({
        ...base,
        health: { enabled: true, pollIntervalSec: 3600, collectTemps: true, collectSmart: false },
      }),
    ).toEqual({
      enabled: true,
      pollIntervalSec: 600,
      collectTemps: true,
      collectSmart: false,
    });
  });

  it('validates c.health in validateConfigPayload', () => {
    const base = buildAgentConfig(defaultSettings('k'), SEED_PCS[0]);
    expect(validateConfigPayload(base)).toBeNull();
    expect(validateConfigPayload({ ...base, health: undefined })).toBeNull();
    expect(
      validateConfigPayload({
        ...base,
        health: { enabled: true, pollIntervalSec: 30, collectTemps: true, collectSmart: false },
      }),
    ).toBeNull();
    expect(
      validateConfigPayload({
        ...base,
        health: { enabled: true, pollIntervalSec: 600, collectTemps: false, collectSmart: true },
      }),
    ).toBeNull();

    expect(
      validateConfigPayload({
        ...base,
        health: { ...DEFAULT_HEALTH_TELEMETRY, pollIntervalSec: 29 },
      }),
    ).toBe('health.pollIntervalSec');

    expect(
      validateConfigPayload({
        ...base,
        health: { ...DEFAULT_HEALTH_TELEMETRY, pollIntervalSec: 601 },
      }),
    ).toBe('health.pollIntervalSec');

    expect(
      validateConfigPayload({
        ...base,
        health: { ...DEFAULT_HEALTH_TELEMETRY, pollIntervalSec: Number.NaN },
      }),
    ).toBe('health.pollIntervalSec');

    expect(
      validateConfigPayload({
        ...base,
        health: { ...DEFAULT_HEALTH_TELEMETRY, collectTemps: 'yes' as unknown as boolean },
      }),
    ).toBe('health.collectTemps');
  });

  it('wires diag commands and health reconfigure on Agent in dry-run', async () => {
    const dataDir = path.join(tmp, 'agent-data');
    const store = new AgentStore(dataDir);
    const sys = new Sys(true, log);
    const agent = new Agent({ sys, log, store, dataDir, presenceMode: 'off' });

    try {
      const cfg1 = buildAgentConfig(defaultSettings('k'), SEED_PCS[0]);
      const cfg2 = {
        ...cfg1,
        rev: `${cfg1.rev}-2`,
        health: { enabled: false, pollIntervalSec: 120, collectTemps: false, collectSmart: false },
      };
      await agent.applyConfig(cfg1);
      const r2 = await agent.applyConfig(cfg2);
      expect(r2.changed).toBe(true);

      const nRes = await agent.diagNotify({ title: 'Club', message: 'Hello', timeoutSec: 15 });
      expect(nRes.ok).toBe(true);
      expect(nRes.message).toContain('[dry-run]');

      const hzRes = await agent.diagRestoreRefreshRate(240);
      expect(hzRes.ok).toBe(true);
      expect(hzRes.message).toContain('[dry-run]');

      const launchRes = await agent.diagRestartLauncher({ app: 'steam' });
      expect(launchRes.ok).toBe(true);
      expect(launchRes.message).toContain('[dry-run]');
    } finally {
      await agent.shutdown();
    }
  });
});
