import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Sys } from '../sys';
import { EXE } from './paths';

export async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

/** Node reports NTFS junctions as symbolic links. */
export async function isLink(p: string): Promise<boolean> {
  return (await lstatOrNull(p))?.isSymbolicLink() ?? false;
}

/** Same as `mklink /J link target`. */
export async function createJunction(sys: Sys, link: string, target: string): Promise<void> {
  if (sys.dryRun) return;
  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(path.resolve(target), link, 'junction');
}

/**
 * Removes the link at `link` and NEVER its target (same as `rd link` without /s).
 * Returns true when nothing is left at `link`.
 */
export async function removeLinkOnly(sys: Sys, link: string): Promise<boolean> {
  if (!(await isLink(link))) return (await lstatOrNull(link)) == null;
  if (sys.dryRun) return true;
  try {
    await fsp.unlink(link);
  } catch {
    await sys.exec(EXE.cmd, ['/d', '/c', 'rd', link]);
  }
  return (await lstatOrNull(link)) == null;
}

/**
 * Prepares <steamcmd>\steamapps for a new junction:
 * an old junction is removed, a real folder is moved aside (steamapps_old_<time>).
 * Game files are never deleted.
 */
export async function freeLinkSlot(sys: Sys, slot: string): Promise<boolean> {
  const st = await lstatOrNull(slot);
  if (!st) return true;
  if (st.isSymbolicLink()) return removeLinkOnly(sys, slot);
  if (sys.dryRun) return true;
  try {
    await fsp.rename(slot, `${slot}_old_${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}
