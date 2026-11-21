import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POST_SESSION_CLEAN, type Occupancy, type PostSessionCleanSettings } from '@vade/protocol';
import { cleanBrowserSessions } from '../src/jobs/browsers';
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
    const settings: PostSessionCleanSettings = { ...DEFAULT_POST_SESSION_CLEAN, closeApps: ['steam.exe', 'discord'], browsers: ['chrome'] };
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
    expect(processesToClose({ ...DEFAULT_POST_SESSION_CLEAN, closeApps: ['Chrome.exe', 'discord.exe'], browsers: ['chrome', 'firefox'] })).toEqual([
      'Chrome.exe',
      'discord.exe',
      'firefox.exe',
    ]);
    expect(processesToClose({ ...DEFAULT_POST_SESSION_CLEAN, closeApps: [], cleanBrowsers: false })).toEqual([]);
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
