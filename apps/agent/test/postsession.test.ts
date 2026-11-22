import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POST_SESSION_CLEAN, type Occupancy, type PostSessionCleanSettings } from '@vade/protocol';
import { cleanBrowserSessions } from '../src/jobs/browsers';
import { cleanLauncherSessions, stripBattleNetAccounts, stripIniSection } from '../src/jobs/launchers';
import { processesToClose, runQuickClean } from '../src/jobs/quickClean';
import { Logger } from '../src/logger';
import { PostSessionWatcher } from '../src/occupancy/postSession';
import { Sys } from '../src/sys';

let tmp: string;
let sys: Sys;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-postsession-'));
  sys = new Sys(false, new Logger(path.join(tmp, 'logs'), false)); // real deletions, but only inside tmp
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function touch(...parts: string[]) {
  const f = path.join(...parts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
  return f;
}
const exists = (...parts: string[]) => fs.existsSync(path.join(...parts));

describe('browser session cleaning (real files in a fake C:\\Users)', () => {
  it('removes sign-in data and keeps bookmarks, extensions and settings', async () => {
    const user = path.join(tmp, 'Users', 'Player');
    const chrome = path.join(user, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
    for (const f of ['Preferences', 'Bookmarks', 'Cookies', 'Network\\Cookies', 'Login Data', 'Web Data', 'Current Session', 'Local Storage\\leveldb\\000.log', 'IndexedDB\\https_web.telegram.org_0\\x', 'Sessions\\Session_1', 'Extensions\\abc\\manifest.json']) touch(chrome, f);
    touch(user, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State');
    const edge = path.join(user, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Profile 1');
    for (const f of ['Preferences', 'Cookies', 'Login Data', 'Favicons']) touch(edge, f);
    const gx = path.join(user, 'AppData', 'Roaming', 'Opera Software', 'Opera GX Stable');
    for (const f of ['Preferences', 'Network\\Cookies', 'Session Storage\\000.log', '_side_profiles\\p1\\Preferences', '_side_profiles\\p1\\Cookies', 'Bookmarks']) touch(gx, f);
    const ff = path.join(user, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles', 'abc.default-release');
    for (const f of ['cookies.sqlite', 'logins.json', 'sessionstore.jsonlz4', 'places.sqlite', 'storage\\default\\https+++faceit.com\\ls\\data.sqlite', 'storage\\permanent\\chrome\\x']) touch(ff, f);

    const r = await cleanBrowserSessions(sys, [user], ['chrome', 'edge', 'opera', 'firefox']);
    expect(r.found).toEqual(['chrome', 'edge', 'opera', 'firefox']);
    expect(r.profiles).toBe(5);
    expect(r.failed).toBe(0);

    // gone
    for (const f of ['Cookies', 'Network\\Cookies', 'Login Data', 'Web Data', 'Current Session', 'Local Storage', 'IndexedDB', 'Sessions']) expect(exists(chrome, f), f).toBe(false);
    expect(exists(edge, 'Cookies') || exists(edge, 'Login Data')).toBe(false);
    expect(exists(gx, 'Network\\Cookies') || exists(gx, 'Session Storage') || exists(gx, '_side_profiles\\p1\\Cookies')).toBe(false);
    for (const f of ['cookies.sqlite', 'logins.json', 'sessionstore.jsonlz4', 'storage\\default']) expect(exists(ff, f), f).toBe(false);
    // kept
    for (const f of ['Preferences', 'Bookmarks', 'Extensions\\abc\\manifest.json']) expect(exists(chrome, f), f).toBe(true);
    expect(exists(user, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State')).toBe(true);
    expect(exists(edge, 'Favicons') && exists(gx, 'Bookmarks') && exists(ff, 'places.sqlite') && exists(ff, 'storage\\permanent\\chrome\\x')).toBe(true);
  });

  it('quick clean touches only sign-in data: no cache, games or Workshop', async () => {
    const steam = path.join(tmp, 'Steam');
    const keep = ['config\\config.vdf', 'appcache\\appinfo.vdf', 'htmlcache\\x', 'steamapps\\common\\Game\\game.exe', 'steamapps\\workshop\\content\\730\\map.vpk', 'userdata\\1\\cfg'];
    for (const f of [...keep, 'config\\loginusers.vdf', 'ssfn123456']) touch(steam, f);
    const user = path.join(tmp, 'Users2', 'Player');
    touch(user, 'AppData', 'Local', 'Steam', 'local.vdf');
    touch(user, 'AppData', 'Local', 'Steam', 'htmlcache', 'x');

    const killed: string[][] = [];
    const noLaunchers = { riot: false, epic: false, battlenet: false, ea: false, discord: false, telegram: false };
    const settings: PostSessionCleanSettings = { ...DEFAULT_POST_SESSION_CLEAN, closeApps: ['steam.exe', 'discord'], browsers: ['chrome'], cleanLaunchers: noLaunchers };
    const r = await runQuickClean({
      sys,
      settings,
      steamPath: steam,
      userDirs: [user],
      log: () => undefined,
      kill: async (names) => (killed.push(names), 3),
      cleanRegistry: async () => ({ cleaned: 1, failed: 0 }),
    });
    expect(killed).toEqual([['steam.exe', 'discord.exe', 'chrome.exe']]);
    expect(r.closed).toBe(3);
    expect(exists(steam, 'config\\loginusers.vdf') || exists(steam, 'ssfn123456') || exists(user, 'AppData\\Local\\Steam\\local.vdf')).toBe(false);
    for (const f of keep) expect(exists(steam, f), f).toBe(true);
    expect(exists(user, 'AppData\\Local\\Steam\\htmlcache\\x')).toBe(true);
    expect(r.summary).toMatch(/логіни Steam: файлів 3, реєстр 1/);
  });

  it('closes the browsers it cleans, without duplicates', () => {
    const noLaunchers = { riot: false, epic: false, battlenet: false, ea: false, discord: false, telegram: false };
    expect(processesToClose({ ...DEFAULT_POST_SESSION_CLEAN, closeApps: ['Chrome.exe', 'discord.exe'], browsers: ['chrome', 'firefox'], cleanLaunchers: noLaunchers })).toEqual([
      'Chrome.exe',
      'discord.exe',
      'firefox.exe',
    ]);
    expect(processesToClose({ ...DEFAULT_POST_SESSION_CLEAN, closeApps: [], cleanBrowsers: false, cleanLaunchers: noLaunchers })).toEqual([]);
  });

  it('closes enabled launcher processes and cleans launcher session tokens without touching games', async () => {
    const procs = processesToClose({
      ...DEFAULT_POST_SESSION_CLEAN,
      closeApps: ['steam.exe'],
      cleanBrowsers: false,
      cleanLaunchers: { riot: true, epic: true, battlenet: true, ea: true, discord: true, telegram: false },
    });
    expect(procs).toContain('RiotClientServices.exe');
    expect(procs).toContain('EpicGamesLauncher.exe');
    expect(procs).toContain('Battle.net.exe');
    expect(procs).toContain('EADesktop.exe');
    expect(procs).toContain('EABackgroundService.exe');
    expect(procs).toContain('Discord.exe');
    expect(procs).not.toContain('Telegram.exe');

    const user = path.join(tmp, 'UsersLaunchers', 'Player');
    const riotYaml = touch(user, 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Data', 'RiotGamesPrivateSettings.yaml');
    const discordDb = touch(user, 'AppData', 'Roaming', 'discord', 'Local Storage', 'leveldb', '000.log');
    const discordCookies = touch(user, 'AppData', 'Roaming', 'discord', 'Network', 'Cookies');
    const epicIni = path.join(user, 'AppData', 'Local', 'EpicGamesLauncher', 'Saved', 'Config', 'Windows', 'GameUserSettings.ini');
    fs.mkdirSync(path.dirname(epicIni), { recursive: true });
    fs.writeFileSync(epicIni, '[Launcher]\nLastActive=1\n\n[RememberMe]\nData=secret_token\n\n[Analytics]\nEnabled=True\n');
    const epicWebcache = touch(user, 'AppData', 'Local', 'EpicGamesLauncher', 'Saved', 'webcache_4430', 'Cache');
    const bnetCfg = path.join(user, 'AppData', 'Roaming', 'Battle.net', 'Battle.net.config');
    fs.mkdirSync(path.dirname(bnetCfg), { recursive: true });
    fs.writeFileSync(
      bnetCfg,
      JSON.stringify({ Client: { SavedAccountNames: 'player@club.gg', AutoLogin: true, InstallPath: 'D:\\Games\\Overwatch' } }),
    );
    const bnetCache = touch(user, 'AppData', 'Local', 'Battle.net', 'BrowserCache', 'x');
    const eaCache = touch(user, 'AppData', 'Local', 'Electronic Arts', 'EA Desktop', 'cache', 'x');
    const eaToken = touch(user, 'AppData', 'Local', 'Electronic Arts', 'EA Desktop', 'user_123.ini');
    const tgData = touch(user, 'AppData', 'Roaming', 'Telegram Desktop', 'tdata', 'key_datas');

    const res = await cleanLauncherSessions(sys, [user], {
      riot: true,
      epic: true,
      battlenet: true,
      ea: true,
      discord: true,
      telegram: false,
    });
    expect(res.failed).toBe(0);
    expect(res.cleaned.sort()).toEqual(['battlenet', 'discord', 'ea', 'epic', 'riot']);
    expect(fs.existsSync(riotYaml)).toBe(false);
    expect(fs.existsSync(discordDb)).toBe(false);
    expect(fs.existsSync(discordCookies)).toBe(false);
    expect(fs.existsSync(epicWebcache)).toBe(false);
    expect(fs.existsSync(bnetCache)).toBe(false);
    expect(fs.existsSync(eaCache)).toBe(false);
    expect(fs.existsSync(eaToken)).toBe(false);
    // Telegram untouched when telegram: false
    expect(fs.existsSync(tgData)).toBe(true);
    // Ini & Battle.net non-auth settings preserved
    const iniAfter = fs.readFileSync(epicIni, 'utf8');
    expect(iniAfter).not.toContain('RememberMe');
    expect(iniAfter).toContain('[Launcher]');
    expect(iniAfter).toContain('[Analytics]');
    const bnetAfter = JSON.parse(fs.readFileSync(bnetCfg, 'utf8'));
    expect(bnetAfter.Client.SavedAccountNames).toBe('');
    expect(bnetAfter.Client.AutoLogin).toBe(false);
    expect(bnetAfter.Client.InstallPath).toBe('D:\\Games\\Overwatch');

    // Pure helpers
    expect(stripIniSection('[A]\nx=1\n[RememberMe]\ny=2\n[B]\nz=3', 'RememberMe')).toBe('[A]\nx=1\n[B]\nz=3');
    expect(stripBattleNetAccounts('not json')).toBeNull();
  });
});

describe('post-session trigger', () => {
  afterEach(() => vi.useRealTimers());

  function make(over: Partial<PostSessionCleanSettings> = {}, busy = false) {
    vi.useFakeTimers();
    let occ: Occupancy = 'unknown';
    const runs: number[] = [];
    const logs: string[] = [];
    const w = new PostSessionWatcher({
      getSettings: () => ({ ...DEFAULT_POST_SESSION_CLEAN, ...over }),
      getOccupancy: () => occ,
      isBusy: () => busy,
      run: async () => void runs.push(Date.now()),
      log: (m) => logs.push(m),
      onPending: () => undefined,
    });
    const set = (next: Occupancy) => {
      const prev = occ;
      occ = next;
      w.onTransition(prev, next);
    };
    return { w, set, runs, logs };
  }

  it('cleans once, delaySec after the client left', async () => {
    const { set, runs } = make({ delaySec: 45 });
    set('occupied');
    set('free');
    await vi.advanceTimersByTimeAsync(44_000);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toHaveLength(1);
    set('free'); // still free: nothing new
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(1);
  });

  it('client came back within the delay: no clean', async () => {
    const { set, runs, logs } = make({ delaySec: 45 });
    set('occupied');
    set('free');
    await vi.advanceTimersByTimeAsync(20_000);
    set('occupied');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(0);
    expect(logs.some((l) => /повернувся/.test(l))).toBe(true);
    set('free'); // leaves for real
    await vi.advanceTimersByTimeAsync(46_000);
    expect(runs).toHaveLength(1);
  });

  it('never cleans without a session before, when unknown, disabled or busy', async () => {
    const a = make();
    a.set('free');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.runs).toHaveLength(0);

    const b = make();
    b.set('occupied');
    b.set('free');
    b.set('unknown');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.runs).toHaveLength(0);

    const c = make({ enabled: false });
    c.set('occupied');
    c.set('free');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.runs).toHaveLength(0);

    const d = make({}, true);
    d.set('occupied');
    d.set('free');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(d.runs).toHaveLength(0);
    expect(d.logs.some((l) => /пропущено/.test(l))).toBe(true);
  });
});
