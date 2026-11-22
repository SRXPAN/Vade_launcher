import fs from 'node:fs';
import path from 'node:path';
import type { InstalledSteamGame } from '@vade/protocol';
import { parseVdf, vdfGet, type VdfObject } from './vdf';

/**
 * All Steam libraries of this PC (C:, D:, ...) from libraryfolders.vdf.
 * Supports the current format ("0" { "path" "D:\\SteamLibrary" ... }) and the old one ("1" "D:\\SteamLibrary").
 * Only folders that really contain steamapps are returned. The Steam folder itself is always first.
 */
export function findLibraries(steamPath: string): string[] {
  const candidates = [path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), path.join(steamPath, 'config', 'libraryfolders.vdf')];
  const paths: string[] = [steamPath];
  for (const file of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const root = vdfGet(parseVdf(text), 'libraryfolders');
    if (root && typeof root === 'object') {
      for (const [key, value] of Object.entries(root)) {
        if (!/^\d+$/.test(key)) continue;
        if (typeof value === 'string') paths.push(value);
        else {
          const p = vdfGet(value as VdfObject, 'path');
          if (typeof p === 'string') paths.push(p);
        }
      }
    }
    break;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const p = path.normalize(raw).replace(/[\\/]+$/, '');
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(path.join(p, 'steamapps'))) out.push(p);
  }
  return out;
}

export interface InstalledApp {
  appId: number;
  name?: string;
  installDir?: string;
  sizeOnDiskBytes?: number;
}

/** Games installed in one library, from steamapps\appmanifest_<id>.acf */
export function installedApps(library: string): InstalledApp[] {
  const dir = path.join(library, 'steamapps');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const apps: InstalledApp[] = [];
  for (const n of names) {
    const m = /^appmanifest_(\d+)\.acf$/i.exec(n);
    if (!m) continue;
    const app: InstalledApp = { appId: Number(m[1]) };
    try {
      const state = vdfGet(parseVdf(fs.readFileSync(path.join(dir, n), 'utf8')), 'AppState');
      if (state && typeof state === 'object') {
        const name = vdfGet(state, 'name');
        if (typeof name === 'string') app.name = name;
        const installDir = vdfGet(state, 'installdir');
        if (typeof installDir === 'string' && installDir.trim()) app.installDir = installDir.trim();
        const sizeRaw = vdfGet(state, 'SizeOnDisk');
        if (typeof sizeRaw === 'string' || typeof sizeRaw === 'number') {
          const parsed = Number(sizeRaw);
          if (Number.isFinite(parsed) && parsed >= 0) app.sizeOnDiskBytes = Math.round(parsed);
        }
      }
    } catch {
      // ignore corrupted manifest metadata
    }
    apps.push(app);
  }
  return apps.sort((a, b) => a.appId - b.appId);
}

/** Full installed game inventory across all Steam libraries on this PC. */
export function listInstalledGames(steamPath: string): InstalledSteamGame[] {
  const out: InstalledSteamGame[] = [];
  for (const lib of findLibraries(steamPath)) {
    for (const app of installedApps(lib)) {
      out.push({
        appId: app.appId,
        name: app.name || `App ${app.appId}`,
        libraryPath: lib,
        ...(app.installDir ? { installDir: app.installDir } : {}),
        sizeOnDiskBytes: app.sizeOnDiskBytes ?? 0,
      });
    }
  }
  return out;
}
