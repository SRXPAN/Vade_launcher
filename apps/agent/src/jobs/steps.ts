import fs from 'node:fs';
import path from 'node:path';
import type { MaintenanceConfig, StepStatus } from '@vade/protocol';
import type { RemoveStats, Sys } from '../sys';
import { sleep } from '../util';
import { EXE, userProfileDirs, WINDOWS_TEMP } from '../win/paths';
import { cleanSteamRegistryAllUsers } from '../win/registry';

export interface StepCtx {
  sys: Sys;
  cfg: MaintenanceConfig;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export interface StepOutcome {
  status?: StepStatus;
  note?: string;
  /** How many errors this step adds to the job (default: 1 if status is error) */
  errors?: number;
}

function add(total: RemoveStats, s: RemoveStats): void {
  total.removed += s.removed;
  total.failed += s.failed;
}

function note(s: RemoveStats, dry: boolean): string {
  const verb = dry ? 'буде видалено' : 'видалено';
  return s.failed ? `${verb} ${s.removed}, зайнятих ${s.failed}` : `${verb} ${s.removed}`;
}

export async function closeSteam(ctx: StepCtx): Promise<StepOutcome> {
  for (const image of ['steam.exe', 'steamwebhelper.exe', 'gameoverlayui.exe']) {
    await ctx.sys.mutate(EXE.taskkill, ['/f', '/im', image]);
  }
  await sleep(ctx.sys.dryRun ? 200 : 5000, ctx.signal);
  return {};
}

/** C:\Users\*\AppData\Local\Temp and C:\Windows\Temp. Locked files are normal and not errors. */
export async function cleanTemp(ctx: StepCtx): Promise<StepOutcome> {
  const dirs = userProfileDirs().map((u) => path.join(u, 'AppData', 'Local', 'Temp'));
  dirs.push(WINDOWS_TEMP);
  const total: RemoveStats = { removed: 0, failed: 0 };
  for (const d of dirs) add(total, await ctx.sys.emptyDir(d, ctx.signal));
  return { note: note(total, ctx.sys.dryRun) };
}

/**
 * Steam sign-in data only: config\loginusers.vdf, ssfn*, every user's AppData\Local\Steam\local.vdf.
 * Shared by the night job and the post-session quick clean. Games, caches and Workshop are not touched.
 */
export async function removeSteamLoginFiles(sys: Sys, steamPath: string, userDirs = userProfileDirs()): Promise<RemoveStats> {
  const total: RemoveStats = { removed: 0, failed: 0 };
  add(total, await sys.removeTree(path.join(steamPath, 'config', 'loginusers.vdf')));
  let ssfn: string[] = [];
  try {
    ssfn = fs.readdirSync(steamPath).filter((n) => /^ssfn/i.test(n));
  } catch {
    // no Steam folder
  }
  for (const n of ssfn) add(total, await sys.removeTree(path.join(steamPath, n)));
  for (const u of userDirs) add(total, await sys.removeTree(path.join(u, 'AppData', 'Local', 'Steam', 'local.vdf')));
  return total;
}

export async function cleanSteamLogins(ctx: StepCtx): Promise<StepOutcome> {
  const { sys, cfg } = ctx;
  const total = await removeSteamLoginFiles(sys, cfg.steamPath);
  const reg = await cleanSteamRegistryAllUsers(sys, ctx.log);
  ctx.log(`  Реєстр: очищено профілів ${reg.cleaned}${reg.failed ? `, помилок ${reg.failed}` : ''}`);
  return {
    status: reg.failed ? 'error' : 'ok',
    errors: reg.failed ? 1 : 0,
    note: `${sys.dryRun ? 'буде видалено файлів' : 'файлів'} ${total.removed}, профілів у реєстрі ${reg.cleaned}`,
  };
}

const STEAM_CACHE_DIRS = ['htmlcache', 'appcache', 'logs', 'dumps', 'depotcache'];

export async function cleanSteamCache(ctx: StepCtx): Promise<StepOutcome> {
  const total: RemoveStats = { removed: 0, failed: 0 };
  for (const d of STEAM_CACHE_DIRS) add(total, await ctx.sys.removeTree(path.join(ctx.cfg.steamPath, d), ctx.signal));
  for (const u of userProfileDirs()) {
    add(total, await ctx.sys.removeTree(path.join(u, 'AppData', 'Local', 'Steam', 'htmlcache'), ctx.signal));
  }
  return { note: note(total, ctx.sys.dryRun) };
}

export async function cleanUserdata(ctx: StepCtx): Promise<StepOutcome> {
  const s = await ctx.sys.removeTree(path.join(ctx.cfg.steamPath, 'userdata'), ctx.signal);
  return { note: note(s, ctx.sys.dryRun) };
}

/** Workshop maps/mods in every library: all games, or only the listed AppIDs. */
export async function cleanWorkshop(ctx: StepCtx, libraries: string[]): Promise<StepOutcome> {
  const { sys, cfg } = ctx;
  const total: RemoveStats = { removed: 0, failed: 0 };
  const only = cfg.workshop.mode === 'list' ? cfg.workshop.appIds : null;
  if (only && only.length === 0) return { status: 'skipped', note: 'список AppID порожній' };
  for (const lib of libraries) {
    const ws = path.join(lib, 'steamapps', 'workshop');
    if (!fs.existsSync(ws)) continue;
    ctx.log(`  Майстерня: ${ws}${only ? ` (AppID ${only.join(', ')})` : ''}`);
    if (!only) {
      for (const d of ['content', 'downloads', 'temp']) add(total, await sys.removeTree(path.join(ws, d), ctx.signal));
      let acfs: string[] = [];
      try {
        acfs = fs.readdirSync(ws).filter((n) => /^appworkshop_\d+\.acf$/i.test(n));
      } catch {
        // ignore
      }
      for (const n of acfs) add(total, await sys.removeTree(path.join(ws, n)));
    } else {
      for (const id of only) {
        for (const d of ['content', 'downloads', 'temp']) add(total, await sys.removeTree(path.join(ws, d, String(id)), ctx.signal));
        add(total, await sys.removeTree(path.join(ws, `appworkshop_${id}.acf`)));
      }
    }
  }
  return { note: note(total, sys.dryRun) };
}
