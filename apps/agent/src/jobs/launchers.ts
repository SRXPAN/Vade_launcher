/**
 * Removes saved sign-in tokens / web caches of club launchers & messengers
 * without touching installed games or unrelated preferences.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CleanLaunchersSettings, LauncherId } from '@vade/protocol';
import type { RemoveStats, Sys } from '../sys';

export interface LauncherCleanResult extends RemoveStats {
  cleaned: LauncherId[];
}

/** Removes an INI section like `[RememberMe]` while preserving all other sections. */
export function stripIniSection(content: string, sectionName: string): string {
  const target = `[${sectionName.toLowerCase()}]`;
  const lines = content.split(/\r?\n/);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      skipping = trimmed.toLowerCase() === target;
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join(eol);
}

/** Clears Battle.net saved account names/tokens in Battle.net.config JSON while keeping installed game settings. */
export function stripBattleNetAccounts(content: string): string | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  let changed = false;
  const scrub = (rec: Record<string, unknown>) => {
    for (const key of Object.keys(rec)) {
      if (/^(SavedAccountNames|SavedAccount.*|AutoLogin.*|RememberAccount.*)$/i.test(key)) {
        const val = rec[key];
        if (typeof val === 'string' && val !== '') {
          rec[key] = '';
          changed = true;
        } else if (typeof val === 'boolean' && val !== false) {
          rec[key] = false;
          changed = true;
        } else if (Array.isArray(val) && val.length > 0) {
          rec[key] = [];
          changed = true;
        } else if (val != null && typeof val === 'object') {
          delete rec[key];
          changed = true;
        }
      }
    }
  };

  scrub(obj);
  if (obj.Client && typeof obj.Client === 'object' && !Array.isArray(obj.Client)) {
    scrub(obj.Client as Record<string, unknown>);
  }
  return changed ? JSON.stringify(obj, null, 2) : null;
}

async function editTextIfExists(
  sys: Sys,
  file: string,
  transform: (text: string) => string | null,
  stats: RemoveStats,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return false;
  }
  const next = transform(raw);
  if (next === null || next === raw) return false;
  if (sys.dryRun) {
    stats.removed++;
    return true;
  }
  try {
    await fsp.writeFile(file, next, 'utf8');
    stats.removed++;
    return true;
  } catch {
    stats.failed++;
    return false;
  }
}

async function removeTreeCounted(sys: Sys, target: string, stats: RemoveStats): Promise<boolean> {
  if (!fs.existsSync(target)) return false;
  const s = await sys.removeTree(target);
  stats.removed += s.removed;
  stats.failed += s.failed;
  return s.removed > 0 || s.failed > 0;
}

export async function cleanLauncherSessions(
  sys: Sys,
  userDirs: string[],
  cfg: CleanLaunchersSettings,
): Promise<LauncherCleanResult> {
  const res: LauncherCleanResult = { removed: 0, failed: 0, cleaned: [] };
  const mark = (id: LauncherId) => {
    if (!res.cleaned.includes(id)) res.cleaned.push(id);
  };

  for (const userDir of userDirs) {
    const local = path.join(userDir, 'AppData', 'Local');
    const roaming = path.join(userDir, 'AppData', 'Roaming');

    if (cfg.riot) {
      const riotData = path.join(local, 'Riot Games', 'Riot Client', 'Data');
      for (const f of ['RiotGamesPrivateSettings.yaml', 'RiotClientPrivateSettings.yaml']) {
        if (await removeTreeCounted(sys, path.join(riotData, f), res)) mark('riot');
      }
    }

    if (cfg.discord) {
      const discordDir = path.join(roaming, 'discord');
      for (const rel of [
        path.join('Local Storage', 'leveldb'),
        'Session Storage',
        path.join('Network', 'Cookies'),
        path.join('Network', 'Cookies-journal'),
      ]) {
        if (await removeTreeCounted(sys, path.join(discordDir, rel), res)) mark('discord');
      }
    }

    if (cfg.epic) {
      const epicSaved = path.join(local, 'EpicGamesLauncher', 'Saved');
      const ini = path.join(epicSaved, 'Config', 'Windows', 'GameUserSettings.ini');
      const didIni = await editTextIfExists(
        sys,
        ini,
        (raw) => {
          const updated = stripIniSection(raw, 'RememberMe');
          return updated === raw ? null : updated;
        },
        res,
      );
      if (didIni) mark('epic');

      try {
        for (const entry of fs.readdirSync(epicSaved, { withFileTypes: true })) {
          if (/^webcache/i.test(entry.name)) {
            if (await removeTreeCounted(sys, path.join(epicSaved, entry.name), res)) mark('epic');
          }
        }
      } catch {
        // folder may not exist
      }
    }

    if (cfg.battlenet) {
      const bnetCfg = path.join(roaming, 'Battle.net', 'Battle.net.config');
      if (await editTextIfExists(sys, bnetCfg, stripBattleNetAccounts, res)) mark('battlenet');
      if (await removeTreeCounted(sys, path.join(local, 'Battle.net', 'BrowserCache'), res)) mark('battlenet');
    }

    if (cfg.ea) {
      const eaDir = path.join(local, 'Electronic Arts', 'EA Desktop');
      if (await removeTreeCounted(sys, path.join(eaDir, 'cache'), res)) mark('ea');
      for (const rel of ['Cookies', path.join('Network', 'Cookies'), 'Local Storage', 'Session Storage']) {
        if (await removeTreeCounted(sys, path.join(eaDir, rel), res)) mark('ea');
      }
      try {
        for (const entry of fs.readdirSync(eaDir, { withFileTypes: true })) {
          if (entry.isFile() && (/(\.token|\.dat)$/i.test(entry.name) || /^user_.*\.ini$/i.test(entry.name))) {
            if (await removeTreeCounted(sys, path.join(eaDir, entry.name), res)) mark('ea');
          }
        }
      } catch {
        // folder may not exist
      }
    }

    if (cfg.telegram) {
      if (await removeTreeCounted(sys, path.join(roaming, 'Telegram Desktop', 'tdata'), res)) mark('telegram');
    }
  }

  return res;
}
