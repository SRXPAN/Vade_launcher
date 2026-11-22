import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GamesInstallResult, GamesUninstallResult } from '@vade/protocol';
import type { Logger } from '../logger';
import { findLibraries } from '../steam/libraries';
import { classifyApp, detectLoginError, ensureSteamcmd, runSteamcmd } from '../steam/steamcmd';
import { parseVdf, vdfGet } from '../steam/vdf';
import type { Sys } from '../sys';
import { errMsg, sleep } from '../util';
import { createJunction, freeLinkSlot, removeLinkOnly } from '../win/junction';
import { EXE } from '../win/paths';

const STEAM_PROCS = ['steam.exe', 'steamwebhelper.exe', 'gameoverlayui.exe'];
const INSTALL_TIMEOUT_MS = 4 * 3600_000;

export interface SafeGamePaths {
  steamappsDir: string;
  commonDir: string;
  manifestPath: string;
  gameDir: string | null;
}

function normWin(p: string): string {
  return path.win32.resolve(p).replace(/[\\]+$/, '').toLowerCase();
}

/**
 * Resolves and validates paths inside `<libraryPath>\steamapps` so no malformed
 * or malicious `installdir` in an `.acf` file can escape the Steam library folder.
 */
export function resolveSafeGamePaths(libraryPath: string, appId: number, installDir: string | undefined): SafeGamePaths {
  if (!Number.isInteger(appId) || appId <= 0) throw new Error('Некоректний AppID');
  const libRoot = path.win32.resolve(libraryPath);
  const steamappsDir = path.win32.resolve(libRoot, 'steamapps');
  const commonDir = path.win32.resolve(steamappsDir, 'common');
  const manifestPath = path.win32.resolve(steamappsDir, `appmanifest_${appId}.acf`);

  let gameDir: string | null = null;
  if (installDir !== undefined) {
    const clean = installDir.trim();
    if (
      !clean ||
      clean.includes('/') ||
      clean.includes('\\') ||
      clean.includes(':') ||
      clean.includes('\0') ||
      clean === '.' ||
      clean === '..' ||
      clean.includes('..')
    ) {
      throw new Error(`Небезпечна назва теки гри (installdir): ${installDir}`);
    }
    const candidate = path.win32.resolve(commonDir, clean);
    const commonPrefix = `${commonDir.toLowerCase()}\\`;
    if (!candidate.toLowerCase().startsWith(commonPrefix) || candidate.length <= commonPrefix.length) {
      throw new Error(`Шлях гри виходить за межі Steam бібліотеки: ${candidate}`);
    }
    gameDir = candidate;
  }

  return { steamappsDir, commonDir, manifestPath, gameDir };
}

async function killSteam(sys: Sys): Promise<void> {
  for (const image of STEAM_PROCS) {
    await sys.mutate(EXE.taskkill, ['/f', '/im', image]);
  }
  await sleep(sys.dryRun ? 100 : 2000);
}

export async function uninstallSteamGame(
  deps: { sys: Sys; log: Logger; steamPath: string; killSteam?: () => Promise<void> },
  args: { appId: number; libraryPath: string },
): Promise<GamesUninstallResult> {
  const { sys, log, steamPath } = deps;
  const appId = Number(args.appId);
  if (!Number.isInteger(appId) || appId <= 0) throw new Error('Некоректний AppID');

  const libraries = findLibraries(steamPath);
  const matchedLib = libraries.find((l) => normWin(l) === normWin(args.libraryPath));
  if (!matchedLib) {
    throw new Error(`Бібліотеку Steam не знайдено або не дозволено: ${args.libraryPath}`);
  }

  const manifestFile = path.join(matchedLib, 'steamapps', `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`Гру AppID ${appId} не знайдено у ${matchedLib}`);
  }

  let gameName = `App ${appId}`;
  let installDir: string | undefined;
  try {
    const state = vdfGet(parseVdf(fs.readFileSync(manifestFile, 'utf8')), 'AppState');
    if (state && typeof state === 'object') {
      const n = vdfGet(state, 'name');
      if (typeof n === 'string' && n.trim()) gameName = n.trim();
      const d = vdfGet(state, 'installdir');
      if (typeof d === 'string' && d.trim()) installDir = d.trim();
    }
  } catch (e) {
    throw new Error(`Не вдалося прочитати маніфест гри: ${errMsg(e)}`);
  }

  // Strictly validate with native path handling as well as win32 rules
  const paths = resolveSafeGamePaths(matchedLib, appId, installDir);
  const localManifest = path.join(matchedLib, 'steamapps', `appmanifest_${appId}.acf`);
  const localGameDir = installDir ? path.join(matchedLib, 'steamapps', 'common', installDir) : null;
  if (localGameDir) {
    const commonBase = path.resolve(matchedLib, 'steamapps', 'common');
    const resolvedGame = path.resolve(localGameDir);
    if (!resolvedGame.startsWith(commonBase + path.sep) && resolvedGame !== localGameDir) {
      throw new Error(`Небезпечний шлях гри: ${resolvedGame}`);
    }
  }

  log.warn(`Видалення гри ${appId} (${gameName}) з ${matchedLib} (${paths.gameDir ?? 'лише маніфест'})…`);
  await (deps.killSteam ? deps.killSteam() : killSteam(sys));

  let removedFiles = 0;
  let failedFiles = 0;
  if (localGameDir && fs.existsSync(localGameDir)) {
    const s1 = await sys.removeTree(localGameDir);
    removedFiles += s1.removed;
    failedFiles += s1.failed;
  }
  const s2 = await sys.removeTree(localManifest);
  removedFiles += s2.removed;
  failedFiles += s2.failed;

  const ok = failedFiles === 0;
  const message = ok
    ? `Видалено ${gameName} (${removedFiles} об'єктів)`
    : `Частково видалено ${gameName} (${removedFiles} видалено, ${failedFiles} зайнято/помилка)`;
  log.log(ok ? 'info' : 'warn', message);
  return { ok, appId, removedFiles, failedFiles, message };
}

export async function installSteamGame(
  deps: { sys: Sys; log: Logger; dataDir: string; steamPath: string; steamcmdDir: string; steamUser: string },
  args: { appId: number; libraryPath?: string },
): Promise<GamesInstallResult> {
  const { sys, log, dataDir, steamPath, steamcmdDir, steamUser } = deps;
  const appId = Number(args.appId);
  if (!Number.isInteger(appId) || appId <= 0) throw new Error('Некоректний AppID');

  const libraries = findLibraries(steamPath);
  let targetLib = steamPath;
  if (args.libraryPath) {
    const matched = libraries.find((l) => normWin(l) === normWin(args.libraryPath!));
    if (!matched) throw new Error(`Бібліотеку Steam не знайдено: ${args.libraryPath}`);
    targetLib = matched;
  } else if (libraries.length > 0) {
    targetLib = libraries[0];
  }

  log.info(`Встановлення/перевірка гри AppID ${appId} у ${targetLib}…`);
  if (sys.dryRun) {
    return { ok: true, appId, status: 'ok', message: '[dry-run] Встановлення через SteamCMD пропущено' };
  }

  await killSteam(sys);
  const exe = await ensureSteamcmd(sys, steamcmdDir, undefined, (m) => log.info(`  ${m}`));
  if (!exe) {
    return { ok: false, appId, status: 'error', message: 'SteamCMD не знайдено і не вдалося завантажити' };
  }

  const slot = path.join(steamcmdDir, 'steamapps');
  const rawFile = path.join(dataDir, 'steamcmd-last.txt');
  await fsp.writeFile(rawFile, '').catch(() => undefined);

  if (!(await freeLinkSlot(sys, slot))) {
    return { ok: false, appId, status: 'error', message: `${slot} зайнятий і не може бути звільнений` };
  }

  let output = '';
  try {
    await createJunction(sys, slot, path.join(targetLib, 'steamapps'));
    const user = steamUser.trim() || 'anonymous';
    const cmdArgs = ['+@NoPromptForPassword', '1', '+login', user, '+app_update', String(appId), 'validate', '+quit'];
    const res = await runSteamcmd(exe, cmdArgs, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      rawFile,
      onLine: (line) => log.log('steam', line.trim()),
    });
    output = res.output;
    if (res.timedOut) {
      return { ok: false, appId, status: 'error', message: 'SteamCMD перевищив ліміт часу (4 год)' };
    }
  } finally {
    if (!(await removeLinkOnly(sys, slot))) {
      log.error(`Не вдалося видалити тимчасовий junction ${slot}`);
    }
  }

  const loginErr = detectLoginError(output);
  if (loginErr) {
    return { ok: false, appId, status: 'login_error', message: loginErr };
  }
  const c = classifyApp(output, appId, false);
  return {
    ok: c.status === 'ok',
    appId,
    status: c.status,
    message: c.message ?? (c.status === 'ok' ? 'Встановлено' : 'Помилка встановлення'),
  };
}
