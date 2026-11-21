import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DETECTOR, type AgentSchedule, type DetectorSettings } from '@vade/protocol';
import { evaluateOccupancy, parseTasklistCsv, type PresenceReport, type ProcInfo } from '../src/occupancy/evaluate';
import { presenceTaskScript, readPresence, reporterScript } from '../src/occupancy/presence';
import { AgentScheduler } from '../src/scheduler';

const cfg = (over: Partial<DetectorSettings> = {}): DetectorSettings => ({ ...DEFAULT_DETECTOR, ...over });
const report = (over: Partial<PresenceReport> = {}): PresenceReport => ({
  v: 1,
  ts: Date.now(),
  session: 1,
  user: 'Player',
  idleMs: 5_000,
  locked: false,
  fgProc: 'explorer.exe',
  fgPath: 'C:\\Windows\\explorer.exe',
  fgTitle: '',
  procs: ['explorer.exe', 'steam.exe'],
  ...over,
});
const procs = (...names: string[]): ProcInfo[] => [{ name: 'svchost.exe', session: 0 }, ...names.map((name) => ({ name, session: 1 }))];

describe('occupancy rules', () => {
  it('a running game always means occupied', () => {
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ procs: ['cs2.exe'], idleMs: 3_600_000 }), procs: null })).toEqual({
      occupancy: 'occupied',
      reason: 'game_running',
      game: 'cs2.exe',
    });
    // case-insensitive, ".exe" optional in the list, works from the tasklist fallback too
    expect(evaluateOccupancy({ settings: cfg({ gameProcesses: ['TSLGAME'] }), presence: null, procs: procs('explorer.exe', 'TslGame.exe') })).toMatchObject({
      occupancy: 'occupied',
      reason: 'game_running',
    });
    // a game in a service session (0) is not a player
    expect(evaluateOccupancy({ settings: cfg(), presence: null, procs: [{ name: 'cs2.exe', session: 0 }] }).reason).toBe('no_session');
  });

  it('any Steam game in the foreground counts, even if not in the list', () => {
    const r = evaluateOccupancy({
      settings: cfg({ gameProcesses: [] }),
      presence: report({ fgProc: 'eldenring.exe', fgPath: 'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe', idleMs: 9_999_999 }),
      procs: null,
    });
    expect(r).toMatchObject({ occupancy: 'occupied', reason: 'game_running', game: 'eldenring.exe' });
  });

  it('mouse / keyboard activity and idle time', () => {
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ idleMs: 60_000 }), procs: null }).reason).toBe('active_input');
    expect(evaluateOccupancy({ settings: cfg({ idleMinutes: 10 }), presence: report({ idleMs: 11 * 60_000 }), procs: null })).toEqual({ occupancy: 'free', reason: 'idle' });
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ idleMs: -1 }), procs: null }).occupancy).toBe('unknown');
  });

  it('Windows lock screen means free (unless a game runs)', () => {
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ locked: true, idleMs: 0 }), procs: null }).reason).toBe('windows_locked');
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ locked: true, procs: ['dota2.exe'] }), procs: null }).reason).toBe('game_running');
  });

  it('SENET: login screen in front = free, client logged in = occupied', () => {
    const senet = cfg({ senetProcesses: ['SenetShell'], senetLockTitles: ['Авторизація'] });
    const base = { procs: ['explorer.exe', 'SenetShell.exe'] };
    expect(
      evaluateOccupancy({ settings: senet, presence: report({ ...base, fgProc: 'SenetShell.exe', fgTitle: 'SENET — Авторизація', idleMs: 0 }), procs: null }),
    ).toEqual({ occupancy: 'free', reason: 'senet_locked' });
    // SENET launcher of a logged-in client (other title) and long idle: still a paid session
    expect(evaluateOccupancy({ settings: senet, presence: report({ ...base, fgProc: 'SenetShell.exe', fgTitle: 'Ігри', idleMs: 99_999_999 }), procs: null }).reason).toBe(
      'senet_session',
    );
    expect(evaluateOccupancy({ settings: senet, presence: report({ ...base, fgProc: 'chrome.exe', idleMs: 99_999_999 }), procs: null }).reason).toBe('senet_session');
    // no SENET configured: the same PC falls back to input activity
    expect(evaluateOccupancy({ settings: cfg(), presence: report({ ...base, idleMs: 99_999_999 }), procs: null }).reason).toBe('idle');
  });

  it('without a report from the player session', () => {
    expect(evaluateOccupancy({ settings: cfg(), presence: null, procs: procs('LogonUI.exe', 'winlogon.exe') })).toEqual({ occupancy: 'free', reason: 'no_session' });
    expect(evaluateOccupancy({ settings: cfg(), presence: null, procs: procs('explorer.exe', 'sihost.exe') })).toEqual({ occupancy: 'unknown', reason: 'no_input_data' });
    expect(evaluateOccupancy({ settings: cfg(), presence: null, procs: null }).reason).toBe('probe_failed');
    expect(evaluateOccupancy({ settings: cfg({ enabled: false }), presence: report(), procs: null }).reason).toBe('disabled');
  });

  it('parses tasklist CSV', () => {
    const out = '"System Idle Process","0","Services","0","8 K"\r\n"cs2.exe","4321","Console","1","2 345 678 K"\r\n"League of Legends.exe","77","Console","1","1 K"\r\n';
    expect(parseTasklistCsv(out)).toEqual([
      { name: 'System Idle Process', session: 0 },
      { name: 'cs2.exe', session: 1 },
      { name: 'League of Legends.exe', session: 1 },
    ]);
  });
});

describe('scheduler and occupied PCs', () => {
  const sched: AgentSchedule = { enabled: true, runTime: '11:00', wakeLeadMin: 2, catchUpMin: 30 };
  function make(isOccupied: () => boolean) {
    const started: string[] = [];
    const logs: string[] = [];
    let key: string | null = null;
    const s = new AgentScheduler({
      getSchedule: () => sched,
      getLastKey: () => key,
      setLastKey: (k) => (key = k),
      isBusy: () => false,
      startJob: (m) => started.push(m),
      log: (m) => logs.push(m),
      blockReason: () => (isOccupied() ? 'запущена гра: cs2.exe' : null),
    });
    return { s, started, logs };
  }

  it('skips while occupied, logs once, starts when the player leaves within the window', () => {
    let occupied = true;
    const { s, started, logs } = make(() => occupied);
    s.tick(new Date(2026, 10, 21, 11, 0, 5));
    s.tick(new Date(2026, 10, 21, 11, 0, 20));
    expect(started).toEqual([]);
    expect(logs.filter((l) => l.startsWith('Skipped: PC is occupied by a player'))).toHaveLength(1);
    occupied = false;
    s.tick(new Date(2026, 10, 21, 11, 12));
    expect(started).toEqual(['scheduled']);
    expect(logs.some((l) => /звільнився/.test(l))).toBe(true);
  });

  it('gives up for the day when the PC stays occupied', () => {
    const { s, started, logs } = make(() => true);
    s.tick(new Date(2026, 10, 21, 11, 1));
    s.tick(new Date(2026, 10, 21, 11, 31));
    s.tick(new Date(2026, 10, 21, 11, 45));
    expect(started).toEqual([]);
    expect(logs.filter((l) => /сьогодні пропущено/.test(l))).toHaveLength(1);
  });
});

describe('player-session reporter (real PowerShell, this Windows session)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-presence-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scripts are valid PowerShell', () => {
    const files = { reporter: reporterScript(dir, 123), task: presenceTaskScript(dir) };
    for (const [name, text] of Object.entries(files)) {
      const f = path.join(dir, `${name}.ps1`);
      fs.writeFileSync(f, `\uFEFF${text}`, 'utf8');
      const errors = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e.Count`],
        { encoding: 'utf8' },
      ).trim();
      expect(`${name}: ${errors}`).toBe(`${name}: 0`);
    }
    // the reporter is embedded in a here-string: it must not contain one itself
    expect(reporterScript(dir)).not.toMatch(/^'@/m);
  });

  it('writes a session report with idle time, lock state and processes', async () => {
    const encoded = Buffer.from(reporterScript(dir, process.pid), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      let r: PresenceReport | null = null;
      for (let i = 0; i < 60 && !r; i++) {
        await new Promise((res) => setTimeout(res, 500));
        r = readPresence(dir);
      }
      expect(r).not.toBeNull();
      expect(Date.now() - r!.ts).toBeLessThan(30_000);
      expect(r!.session).toBeGreaterThan(0);
      expect(r!.user).toBe(os.userInfo().username);
      expect(r!.idleMs).toBeGreaterThanOrEqual(0);
      expect(typeof r!.locked).toBe('boolean');
      expect(r!.procs.map((p) => p.toLowerCase())).toContain('powershell.exe');
    } finally {
      child.kill();
    }
  }, 60_000);
});
