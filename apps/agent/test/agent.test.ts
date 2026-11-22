import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateConfigPayload } from '../src/agent';
import { collectActiveLanInfo } from '../src/discovery';
import { isAppErrorStatus, JobRunner, partitionLibraryApps, planSteps } from '../src/jobs/runner';
import { splitArgs, waitForNetworkIdle } from '../src/jobs/extraUpdaters';
import { Logger } from '../src/logger';
import { AgentScheduler } from '../src/scheduler';
import { findLibraries, installedApps } from '../src/steam/libraries';
import { classifyApp, classifySteamLogin, detectLoginError, parseAppResultLine, parseProgress } from '../src/steam/steamcmd';
import { parseVdf } from '../src/steam/vdf';
import { AgentStore } from '../src/store';
import { decodeConsoleBuffer, decodeCp866, parseChcpLabel, Sys } from '../src/sys';
import { DEFENDER_EXCLUSION_PATHS, defenderExclusionScript, ensureDefenderExclusions } from '../src/win/defender';
import { healthChanged, parseNvidiaTemp, parseRamTotalGb, parseRefreshRate, parseSsdJson } from '../src/win/health';
import { createJunction, freeLinkSlot, isLink, removeLinkOnly } from '../src/win/junction';
import { buildAgentConfig, defaultSettings, DEFAULT_MAINTENANCE, SEED_PCS, type AgentSchedule, type JobState } from '@vade/protocol';

let tmp: string;
let log: Logger;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-agent-test-'));
  log = new Logger(path.join(tmp, 'logs'), false);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('vdf', () => {
  it('parses the current libraryfolders.vdf format', () => {
    const v = parseVdf(`"libraryfolders"
{
  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "228980" "123" } }
  "1" { "path" "D:\\\\SteamLibrary" "label" "" }
}`);
    const lf = v.libraryfolders as Record<string, Record<string, string>>;
    expect(lf['0'].path).toBe('C:\\Program Files (x86)\\Steam');
    expect(lf['1'].path).toBe('D:\\SteamLibrary');
  });
  it('handles comments, conditions and the old format', () => {
    const v = parseVdf(`// comment\n"LibraryFolders" { "TimeNextStatsReport" "1" "1" "E:\\\\Games\\\\Steam" [$WIN32] }`);
    expect((v.LibraryFolders as Record<string, string>)['1']).toBe('E:\\Games\\Steam');
  });
});

describe('steam libraries', () => {
  it('finds every library and installed game', () => {
    const steam = path.join(tmp, 'Steam');
    const lib2 = path.join(tmp, 'D', 'SteamLibrary');
    fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
    fs.mkdirSync(path.join(lib2, 'steamapps'), { recursive: true });
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "0" { "path" "${steam.replace(/\\/g, '\\\\')}" } "1" { "path" "${lib2.replace(/\\/g, '\\\\')}" } "2" { "path" "Z:\\\\missing" } }`,
    );
    fs.writeFileSync(path.join(lib2, 'steamapps', 'appmanifest_730.acf'), '"AppState" { "appid" "730" "name" "Counter-Strike 2" }');
    fs.writeFileSync(path.join(lib2, 'steamapps', 'appmanifest_570.acf'), '"AppState" { "appid" "570" "name" "Dota 2" }');
    const libs = findLibraries(steam);
    expect(libs).toEqual([steam, lib2]);
    expect(installedApps(lib2)).toEqual([
      { appId: 570, name: 'Dota 2' },
      { appId: 730, name: 'Counter-Strike 2' },
    ]);
  });
});

describe('steamcmd output', () => {
  it('parses progress and per-app results', () => {
    expect(parseProgress(' Update state (0x61) downloading, progress: 45.23 (1048576 / 2318745)')).toEqual({
      phase: 'downloading',
      pct: 45.23,
      done: 1048576,
      total: 2318745,
    });
    expect(parseAppResultLine("Success! App '730' fully installed.")).toMatchObject({ appId: 730, status: 'ok' });
    expect(parseAppResultLine("Success! App '570' already up to date.")).toMatchObject({ appId: 570, status: 'ok' });
    expect(parseAppResultLine("ERROR! Failed to install app '578080' (No subscription)")).toMatchObject({
      appId: 578080,
      status: 'skipped_no_subscription',
    });
    expect(parseAppResultLine("ERROR! Failed to install app '1422450' (Invalid Platform)")).toMatchObject({
      appId: 1422450,
      status: 'skipped_no_subscription',
    });
    expect(parseAppResultLine("ERROR! Failed to install app '1422450' (Missing configuration)")).toMatchObject({
      appId: 1422450,
      status: 'skipped_no_subscription',
    });
    expect(parseAppResultLine("ERROR! Failed to install app '440' (Disk write failure)")).toMatchObject({ status: 'error', message: 'Disk write failure' });
  });
  it('detects login problems', () => {
    const out = "Logging in user 'club' to Steam Public...FAILED (Invalid Password)\n";
    expect(detectLoginError(out)).toBeTruthy();
    expect(classifyApp(out, 730, true)).toMatchObject({ status: 'login_error' });
    expect(classifySteamLogin(out).outcome).toBe('invalid_password');
    expect(classifySteamLogin("Logging in user 'club' [U:1:1] to Steam Public...OK\nWaiting for user info...OK").outcome).toBe('ok');
    expect(classifySteamLogin('This computer has not been authenticated for your account using Steam Guard.').outcome).toBe('guard_required');
    expect(detectLoginError("Success! App '730' already up to date.")).toBeNull();
  });
});

describe('junction safety (real NTFS)', () => {
  it('removes only the link, never the game files behind it', async () => {
    const sys = new Sys(false, log);
    const game = path.join(tmp, 'Library', 'steamapps');
    fs.mkdirSync(path.join(game, 'common', 'Game'), { recursive: true });
    fs.writeFileSync(path.join(game, 'common', 'Game', 'game.exe'), 'x');
    const slot = path.join(tmp, 'steamcmd', 'steamapps');

    await createJunction(sys, slot, game);
    expect(await isLink(slot)).toBe(true);
    expect(fs.existsSync(path.join(slot, 'common', 'Game', 'game.exe'))).toBe(true);

    expect(await removeLinkOnly(sys, slot)).toBe(true);
    expect(fs.existsSync(slot)).toBe(false);
    expect(fs.existsSync(path.join(game, 'common', 'Game', 'game.exe'))).toBe(true);
  });

  it('removeTree / emptyDir do not walk into junctions', async () => {
    const sys = new Sys(false, log);
    const precious = path.join(tmp, 'precious');
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, 'keep.txt'), 'keep');
    const temp = path.join(tmp, 'Temp');
    fs.mkdirSync(path.join(temp, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'a.tmp'), 'a');
    fs.writeFileSync(path.join(temp, 'sub', 'b.tmp'), 'b');
    fs.symlinkSync(precious, path.join(temp, 'sub', 'link-to-precious'), 'junction');

    const stats = await sys.emptyDir(temp);
    expect(stats.failed).toBe(0);
    expect(fs.readdirSync(temp)).toEqual([]);
    expect(fs.readFileSync(path.join(precious, 'keep.txt'), 'utf8')).toBe('keep');

    fs.symlinkSync(precious, path.join(tmp, 'top-link'), 'junction');
    await sys.removeTree(path.join(tmp, 'top-link'));
    expect(fs.existsSync(path.join(tmp, 'top-link'))).toBe(false);
    expect(fs.existsSync(path.join(precious, 'keep.txt'))).toBe(true);
  });

  it('moves a real steamapps folder aside instead of deleting it', async () => {
    const sys = new Sys(false, log);
    const slot = path.join(tmp, 'steamcmd2', 'steamapps');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(path.join(slot, 'file'), '1');
    expect(await freeLinkSlot(sys, slot)).toBe(true);
    expect(fs.existsSync(slot)).toBe(false);
    const moved = fs.readdirSync(path.dirname(slot)).find((n) => n.startsWith('steamapps_old_'));
    expect(moved).toBeTruthy();
  });

  it('dry-run deletes nothing', async () => {
    const sys = new Sys(true, log);
    const dir = path.join(tmp, 'dry');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x'), 'x');
    const s = await sys.emptyDir(dir);
    expect(s.removed).toBe(1);
    expect(fs.existsSync(path.join(dir, 'x'))).toBe(true);
  });
});

describe('job planning and config validation', () => {
  it('plans steps like the .bat', () => {
    expect(planSteps(DEFAULT_MAINTENANCE, 'scheduled')).toEqual(['closeSteam', 'cleanTemp', 'steamLogins', 'steamCache', 'workshop', 'update', 'after']);
    expect(planSteps(DEFAULT_MAINTENANCE, 'test')).not.toContain('after');
  });
  it('rejects dangerous paths', () => {
    const cfg = buildAgentConfig(defaultSettings('k'), SEED_PCS[0]);
    expect(validateConfigPayload(cfg)).toBeNull();
    expect(validateConfigPayload({ ...cfg, maintenance: { ...cfg.maintenance, steamPath: 'C:\\' } })).toMatch(/корінь/);
    expect(validateConfigPayload({ ...cfg, maintenance: { ...cfg.maintenance, steamPath: 'Steam' } })).toMatch(/абсолютний/);
  });

  it('partitions ignored apps in auto mode and classifies error statuses per treatNoSubscriptionAsError', () => {
    const installed = [
      { appId: 730, name: 'Counter-Strike 2' },
      { appId: 1422450, name: 'Deadlock' },
      { appId: 570, name: 'Dota 2' },
    ];
    const autoPart = partitionLibraryApps(installed, {
      ...DEFAULT_MAINTENANCE.update,
      mode: 'auto',
      ignoreAppIds: [1422450],
    });
    expect(autoPart.toUpdate.map((a) => a.appId)).toEqual([730, 570]);
    expect(autoPart.ignored.map((a) => a.appId)).toEqual([1422450]);

    const listPart = partitionLibraryApps(installed, {
      ...DEFAULT_MAINTENANCE.update,
      mode: 'list',
      appIds: [730],
      ignoreAppIds: [730],
    });
    expect(listPart.toUpdate.map((a) => a.appId)).toEqual([730]);
    expect(listPart.ignored).toEqual([]);

    expect(isAppErrorStatus('ignored', true)).toBe(false);
    expect(isAppErrorStatus('skipped_no_subscription', false)).toBe(false);
    expect(isAppErrorStatus('skipped_no_subscription', true)).toBe(true);
    expect(isAppErrorStatus('error', false)).toBe(true);
    expect(isAppErrorStatus('login_error', false)).toBe(true);
  });

  it('skips ignoreAppIds in auto mode and finishes with ok on No subscription when treatNoSubscriptionAsError is false', async () => {
    const runDir = path.join(tmp, 'runner-auto-ok');
    const steam = path.join(runDir, 'Steam');
    const steamcmd = path.join(runDir, 'steamcmd');
    fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
    fs.mkdirSync(steamcmd, { recursive: true });
    fs.writeFileSync(path.join(steam, 'steam.exe'), '');
    fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_730.acf'), '"AppState" { "appid" "730" "name" "Counter-Strike 2" }');
    fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_1422450.acf'), '"AppState" { "appid" "1422450" "name" "Deadlock" }');
    fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_578080.acf'), '"AppState" { "appid" "578080" "name" "PUBG" }');

    const runScenario = async (name: string, treatNoSubscriptionAsError: boolean, ignoreAppIds: number[]) => {
      const dataDir = path.join(runDir, name);
      fs.mkdirSync(dataDir, { recursive: true });
      const settings = defaultSettings('k');
      settings.maintenance = {
        ...DEFAULT_MAINTENANCE,
        steamPath: steam,
        steamcmdDir: steamcmd,
        cleanTemp: false,
        cleanSteamLogins: false,
        cleanSteamCache: false,
        cleanUserdata: false,
        workshop: { enabled: false, mode: 'all', appIds: [] },
        update: {
          enabled: true,
          steamUser: 'club',
          mode: 'auto',
          appIds: [],
          ignoreAppIds,
          treatNoSubscriptionAsError,
          validate: false,
        },
      };
      const cfg = buildAgentConfig(settings, SEED_PCS[0]);
      const calls: string[][] = [];
      let finishedJob: JobState | null = null;
      const sys = new Sys(false, log);
      // Avoid calling real taskkill during closeSteam
      sys.mutate = async () => ({ code: 0, stdout: '', stderr: '' });
      const runner = new JobRunner({
        sys,
        log,
        dataDir,
        getConfig: () => cfg,
        changed: () => undefined,
        finished: (j) => (finishedJob = j),
        schedulePower: () => undefined,
        steamcmdBusy: () => false,
        steamcmdOps: {
          ensureSteamcmd: async () => path.join(steamcmd, 'steamcmd.exe'),
          freeLinkSlot: async () => true,
          createJunction: async () => undefined,
          removeLinkOnly: async () => true,
          runSteamcmd: async (_exe, args, opts) => {
            calls.push(args);
            const lines = [
              "Success! App '730' already up to date.",
              "ERROR! Failed to install app '578080' (No subscription)",
            ];
            for (const line of lines) opts.onLine?.(line);
            return { output: `${lines.join('\n')}\n`, code: 0, timedOut: false, aborted: false };
          },
        },
      });
      runner.start('test');
      await runner.waitIdle(15_000);
      return { job: finishedJob!, calls };
    };

    const [r1, r2, r3] = await Promise.all([
      runScenario('default', false, [1422450]),
      runScenario('strict', true, [1422450]),
      runScenario('all-ignored', false, [730, 578080, 1422450]),
    ]);

    // 1. Default (treatNoSubscriptionAsError: false) + ignoreAppIds: [1422450]
    expect(r1.calls).toHaveLength(1);
    expect(r1.calls[0]).toContain('730');
    expect(r1.calls[0]).toContain('578080');
    expect(r1.calls[0]).not.toContain('1422450');
    expect(r1.job.errors).toBe(0);
    expect(r1.job.result).toBe('ok');
    expect(r1.job.steps.find((s) => s.id === 'update')?.status).toBe('ok');
    expect(r1.job.apps.find((a) => a.appId === 1422450)).toMatchObject({ status: 'ignored' });
    expect(r1.job.apps.find((a) => a.appId === 730)).toMatchObject({ status: 'ok' });
    expect(r1.job.apps.find((a) => a.appId === 578080)).toMatchObject({ status: 'skipped_no_subscription' });

    // 2. Strict mode (treatNoSubscriptionAsError: true) marks No subscription as an error
    expect(r2.job.errors).toBe(1);
    expect(r2.job.result).toBe('errors');
    expect(r2.job.steps.find((s) => s.id === 'update')?.status).toBe('error');

    // 3. When all installed games are ignored, SteamCMD is not launched at all
    expect(r3.calls).toHaveLength(0);
    expect(r3.job.errors).toBe(0);
    expect(r3.job.result).toBe('ok');
    expect(r3.job.apps.every((a) => a.status === 'ignored')).toBe(true);
  }, 15_000);
});

describe('agent scheduler', () => {
  function make(schedule: AgentSchedule, lastKey: string | null = null) {
    const started: string[] = [];
    let key = lastKey;
    const s = new AgentScheduler({
      getSchedule: () => schedule,
      getLastKey: () => key,
      setLastKey: (k) => (key = k),
      isBusy: () => false,
      startJob: (m) => started.push(m),
      log: () => undefined,
    });
    return { s, started };
  }
  const sched: AgentSchedule = { enabled: true, runTime: '11:05', wakeLeadMin: 2, catchUpMin: 30 };

  it('runs once per slot, with catch-up window', () => {
    const { s, started } = make(sched);
    s.tick(new Date(2026, 10, 21, 11, 4));
    expect(started).toEqual([]);
    s.tick(new Date(2026, 10, 21, 11, 5));
    s.tick(new Date(2026, 10, 21, 11, 6));
    expect(started).toEqual(['scheduled']);
  });
  it('does not run when the PC comes online too late', () => {
    const { s, started } = make(sched);
    s.tick(new Date(2026, 10, 21, 12, 0));
    expect(started).toEqual([]);
  });
  it('a new schedule in the past is marked as done', () => {
    expect(AgentScheduler.pastSlotKey(sched, new Date(2026, 10, 21, 11, 10))).toBe('2026-11-21');
  });
});

describe('CP866 console decoding, Defender exclusions and LAN beacon', () => {
  it('decodes CP866 console output buffers into readable UTF-8 text', () => {
    // "Операция успешно завершена." in CP866 (IBM866):
    // О=0x8E п=0xAF е=0xA5 р=0xE0 а=0xA0 ц=0xE6 и=0xA8 я=0xEF ' '=0x20
    // у=0xE3 с=0xE1 п=0xAF е=0xA5 ш=0xE8 н=0xAD о=0xAE ' '=0x20
    // з=0xA7 а=0xA0 в=0xA2 е=0xA5 р=0xE0 ш=0xE8 е=0xA5 н=0xAD а=0xA0 .=0x2E
    const cp866Bytes = Buffer.from([
      0x8e, 0xaf, 0xa5, 0xe0, 0xa0, 0xe6, 0xa8, 0xef, 0x20,
      0xe3, 0xe1, 0xaf, 0xa5, 0xe8, 0xad, 0xae, 0x20,
      0xa7, 0xa0, 0xa2, 0xa5, 0xe0, 0xe8, 0xa5, 0xad, 0xa0, 0x2e,
    ]);
    expect(decodeCp866(cp866Bytes)).toBe('Операция успешно завершена.');
    expect(decodeConsoleBuffer(cp866Bytes, 'oem')).toBe('Операция успешно завершена.');
    expect(decodeConsoleBuffer(Buffer.from('ASCII only 123'), 'oem')).toBe('ASCII only 123');
    expect(decodeConsoleBuffer(Buffer.from('Успішно виконано (UTF-8)', 'utf8'), 'utf8')).toBe('Успішно виконано (UTF-8)');
    expect(parseChcpLabel('Текущая кодовая страница: 866\r\n')).toBe('ibm866');
    expect(parseChcpLabel('Active code page: 65001')).toBe('utf-8');
  });

  it('registers Windows Defender exclusions once per agent version without throwing on failure', async () => {
    const dir = path.join(tmp, 'defender-state');
    const store = new AgentStore(dir);
    const sys = new Sys(true, log);
    const script = defenderExclusionScript();
    for (const p of DEFENDER_EXCLUSION_PATHS) expect(script).toContain(p);

    const ok = await ensureDefenderExclusions(sys, log, store, '0.4.0');
    expect(ok).toBe(true);
    expect(store.state.defenderExcludedVersion).toBe('0.4.0');

    // Second call for the same version is a no-op
    let psCalled = false;
    sys.powershell = async () => {
      psCalled = true;
      return { code: 0, stdout: 'OK', stderr: '' };
    };
    await ensureDefenderExclusions(sys, log, store, '0.4.0');
    expect(psCalled).toBe(false);

    // Next version runs again and swallows Defender errors quietly
    sys.powershell = async () => ({ code: 0, stdout: 'SKIP: Defender disabled', stderr: '' });
    const ok2 = await ensureDefenderExclusions(sys, log, store, '0.5.0');
    expect(ok2).toBe(false);
    expect(store.state.defenderExcludedVersion).toBe('0.5.0');
  });

  it('collects non-virtual IPv4 MACs and subnet broadcast addresses for the discovery beacon', () => {
    const info = collectActiveLanInfo({
      'Ethernet': [
        {
          address: '10.70.4.112',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '30:56:0F:3E:93:88',
          internal: false,
          cidr: '10.70.4.112/24',
        },
      ],
      'vEthernet (WSL)': [
        {
          address: '172.24.0.1',
          netmask: '255.255.240.0',
          family: 'IPv4',
          mac: '00:15:5d:aa:bb:cc',
          internal: false,
          cidr: '172.24.0.1/20',
        },
      ],
    });
    expect(info.macs).toEqual(['30:56:0f:3e:93:88']);
    expect(info.broadcasts).toEqual(['255.255.255.255', '10.70.4.255']);
  });
});

describe('HardwareHealth parsers and ExtraUpdaters network idle wait', () => {
  it('parses GPU temp, monitor refresh rate, RAM and SSD SMART JSON (single object & array)', () => {
    expect(parseNvidiaTemp('64\r\n')).toBe(64);
    expect(parseNvidiaTemp('not-installed')).toBeNull();
    expect(parseRefreshRate('60\r\n240\r\n144\r\n')).toBe(240);
    expect(parseRefreshRate('')).toBeNull();
    expect(parseRamTotalGb(String(32 * 1024 ** 3))).toBe(32);

    const single = parseSsdJson('{"Model":"Samsung 980 PRO","HealthStatus":"Healthy","Wear":8,"Temp":41}');
    expect(single).toEqual([{ model: 'Samsung 980 PRO', healthStatus: 'Healthy', wearPct: 8, tempC: 41 }]);

    const multi = parseSsdJson('[{"Model":"NVMe1","HealthStatus":"Healthy","Wear":15,"Temp":39},{"Model":"NVMe2","HealthStatus":"Warning","Wear":92,"Temp":null}]');
    expect(multi).toHaveLength(2);
    expect(multi[1]).toEqual({ model: 'NVMe2', healthStatus: 'Warning', wearPct: 92, tempC: null });
    expect(parseSsdJson('')).toEqual([]);

    expect(
      healthChanged(
        { ramTotalGb: 32, refreshRateHz: 240, ssd: single, gpuTempC: 60, cpuTempC: null },
        { ramTotalGb: 32, refreshRateHz: 240, ssd: single, gpuTempC: 61, cpuTempC: null },
      ),
    ).toBe(false);
    expect(
      healthChanged(
        { ramTotalGb: 32, refreshRateHz: 240, ssd: single, gpuTempC: 60, cpuTempC: null },
        { ramTotalGb: 32, refreshRateHz: 60, ssd: single, gpuTempC: 60, cpuTempC: null },
      ),
    ).toBe(true);
  });

  it('waits minWaitMs, stays active while downloading, and finishes on 60s continuous idle or maxWaitMs timeout', async () => {
    expect(splitArgs('--launch-product=valorant "hello world"')).toEqual(['--launch-product=valorant', 'hello world']);

    // 1. Download active (500 KB/s for 2 polls), then idle (<200 KB/s) for 60s
    let fakeNow = 0;
    let totalBytes = 0;
    const speedsKbPerSec = [600, 500, 50, 40, 20, 10]; // first 2 ticks busy, next 4 ticks (60s) idle
    let idx = 0;
    const resIdle = await waitForNetworkIdle({
      minWaitMs: 180_000,
      maxWaitMs: 1_200_000,
      idleKbps: 200,
      pollMs: 15_000,
      idleConfirmMs: 60_000,
      nowFn: () => fakeNow,
      sleepFn: async (ms) => {
        fakeNow += ms;
        if (fakeNow > 180_000) {
          const kbps = speedsKbPerSec[Math.min(idx++, speedsKbPerSec.length - 1)];
          totalBytes += kbps * 1024 * (ms / 1000);
        }
      },
      readRxBytes: async () => totalBytes,
    });
    expect(resIdle.reason).toBe('idle');
    expect(resIdle.peakKbps).toBeGreaterThanOrEqual(500);
    // 180s minWait + 30s active + 60s continuous idle = 270s
    expect(resIdle.elapsedMs).toBe(270_000);

    // 2. Continuous download exceeds maxWaitMs -> timeout
    let now2 = 0;
    let bytes2 = 0;
    const resTimeout = await waitForNetworkIdle({
      minWaitMs: 60_000,
      maxWaitMs: 120_000,
      idleKbps: 200,
      pollMs: 15_000,
      idleConfirmMs: 60_000,
      nowFn: () => now2,
      sleepFn: async (ms) => {
        now2 += ms;
        bytes2 += 1000 * 1024 * (ms / 1000);
      },
      readRxBytes: async () => bytes2,
    });
    expect(resTimeout.reason).toBe('timeout');
    expect(resTimeout.elapsedMs).toBe(120_000);

    // 3. Aborted early
    const ac = new AbortController();
    ac.abort();
    const resAbort = await waitForNetworkIdle({
      minWaitMs: 60_000,
      maxWaitMs: 120_000,
      idleKbps: 200,
      readRxBytes: async () => 0,
      signal: ac.signal,
    });
    expect(resAbort.reason).toBe('aborted');

    // 4. planSteps includes extraUpdaters when enabled
    expect(
      planSteps({ ...DEFAULT_MAINTENANCE, extraUpdaters: { ...DEFAULT_MAINTENANCE.extraUpdaters, enabled: true } }, 'scheduled'),
    ).toEqual(['closeSteam', 'cleanTemp', 'steamLogins', 'steamCache', 'workshop', 'update', 'extraUpdaters', 'after']);
  });
});
