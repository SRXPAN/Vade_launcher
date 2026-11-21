import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateConfigPayload } from '../src/agent';
import { planSteps } from '../src/jobs/runner';
import { Logger } from '../src/logger';
import { AgentScheduler } from '../src/scheduler';
import { findLibraries, installedApps } from '../src/steam/libraries';
import { classifyApp, classifySteamLogin, detectLoginError, parseAppResultLine, parseProgress } from '../src/steam/steamcmd';
import { parseVdf } from '../src/steam/vdf';
import { Sys } from '../src/sys';
import { createJunction, freeLinkSlot, isLink, removeLinkOnly } from '../src/win/junction';
import { buildAgentConfig, defaultSettings, DEFAULT_MAINTENANCE, SEED_PCS, type AgentSchedule } from '@vade/protocol';

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
