import fs from 'node:fs';
import path from 'node:path';
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
      const name = typeof state === 'object' ? vdfGet(state, 'name') : undefined;
      if (typeof name === 'string') app.name = name;
    } catch {
      // the name is cosmetic
    }
    apps.push(app);
  }
  return apps.sort((a, b) => a.appId - b.appId);
}
