/**
 * Post-session quick clean (2–3 s): close apps, remove Steam sign-in data and browser sessions.
 * Unlike the night job it never touches caches, games, Workshop content and never runs SteamCMD.
 */
import { BROWSER_PROCESSES, BROWSER_TITLES, type PostSessionCleanSettings, type QuickCleanResult } from '@vade/protocol';
import type { Sys } from '../sys';
import { sleep } from '../util';
import { EXE, userProfileDirs } from '../win/paths';
import { cleanSteamRegistryAllUsers } from '../win/registry';
import { cleanBrowserSessions } from './browsers';
import { removeSteamLoginFiles } from './steps';

export interface QuickCleanDeps {
  sys: Sys;
  settings: PostSessionCleanSettings;
  steamPath: string;
  log: (msg: string) => void;
  /** Override for tests; default: C:\Users\* */
  userDirs?: string[];
  /** Pause after closing apps so they release their files (default 1500 ms) */
  settleMs?: number;
  /** Overrides for tests: never kill real processes or touch the real registry there */
  kill?: (names: string[]) => Promise<number>;
  cleanRegistry?: () => Promise<{ cleaned: number; failed: number }>;
}

/** One taskkill call; every terminated process prints one line to stdout. */
async function killWithTaskkill(sys: Sys, names: string[]): Promise<number> {
  const r = await sys.mutate(EXE.taskkill, ['/f', '/t', ...names.flatMap((n) => ['/im', n])], 30_000);
  return r.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
}

/** closeApps plus the processes of the browsers that will be cleaned, without duplicates. */
export function processesToClose(s: PostSessionCleanSettings): string[] {
  const names = [...s.closeApps, ...(s.cleanBrowsers ? s.browsers.map((b) => BROWSER_PROCESSES[b]) : [])];
  const out: string[] = [];
  for (const n of names) {
    const v = n.trim().toLowerCase().endsWith('.exe') ? n.trim() : `${n.trim()}.exe`;
    if (v !== '.exe' && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

export async function runQuickClean(d: QuickCleanDeps): Promise<QuickCleanResult> {
  const started = Date.now();
  const { sys, settings: s } = d;
  const userDirs = d.userDirs ?? userProfileDirs();
  const parts: string[] = [];
  let closed = 0;
  let removed = 0;
  let failed = 0;

  // 1. Close apps.
  const names = processesToClose(s);
  if (names.length) {
    closed = await (d.kill ?? ((n: string[]) => killWithTaskkill(sys, n)))(names);
    if (!sys.dryRun && closed > 0) await sleep(d.settleMs ?? 1500);
    parts.push(`закрито процесів: ${closed}`);
  }

  // 2. Steam sign-in data only.
  if (s.cleanSteamLogins) {
    const files = await removeSteamLoginFiles(sys, d.steamPath, userDirs);
    const reg = await (d.cleanRegistry ?? (() => cleanSteamRegistryAllUsers(sys, d.log, { offlineHives: false })))();
    removed += files.removed;
    failed += files.failed + reg.failed;
    parts.push(`логіни Steam: файлів ${files.removed}, реєстр ${reg.cleaned}`);
  }

  // 3. Browser sessions.
  if (s.cleanBrowsers && s.browsers.length) {
    const b = await cleanBrowserSessions(sys, userDirs, s.browsers);
    removed += b.removed;
    failed += b.failed;
    parts.push(
      b.found.length
        ? `браузери (${b.found.map((x) => BROWSER_TITLES[x]).join(', ')}): профілів ${b.profiles}, видалено ${b.removed}${b.failed ? `, зайнятих ${b.failed}` : ''}`
        : 'браузерів не знайдено',
    );
  }

  const ms = Date.now() - started;
  return { closed, removed, failed, ms, summary: `${sys.dryRun ? '[dry-run] ' : ''}${parts.join('; ')} — ${(ms / 1000).toFixed(1)} с` };
}
