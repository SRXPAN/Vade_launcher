import fs from 'node:fs';
import path from 'node:path';

const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
const sys32 = path.join(sysRoot, 'System32');

/** Absolute paths: the service runs as SYSTEM and must not depend on PATH. */
export const EXE = {
  cmd: path.join(sys32, 'cmd.exe'),
  reg: path.join(sys32, 'reg.exe'),
  taskkill: path.join(sys32, 'taskkill.exe'),
  powercfg: path.join(sys32, 'powercfg.exe'),
  shutdown: path.join(sys32, 'shutdown.exe'),
  tar: path.join(sys32, 'tar.exe'),
  tasklist: path.join(sys32, 'tasklist.exe'),
  icacls: path.join(sys32, 'icacls.exe'),
  conhost: path.join(sys32, 'conhost.exe'),
  powershell: path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  net: path.join(sys32, 'net.exe'),
  w32tm: path.join(sys32, 'w32tm.exe'),
  nvidiaSmi: path.join(sys32, 'nvidia-smi.exe'),
};

export const WINDOWS_TEMP = path.join(sysRoot, 'Temp');

/** C:\Users (derived from %PUBLIC%, which exists for SYSTEM too). */
export function usersRoot(): string {
  if (process.env.PUBLIC) return path.dirname(process.env.PUBLIC);
  return path.join(process.env.SystemDrive ?? 'C:', '\\Users');
}

/**
 * Real profile folders in C:\Users. Junctions such as "All Users" and
 * "Default User" are skipped so nothing is processed twice or followed.
 */
export function userProfileDirs(root = usersRoot()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(root, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) out.push(p);
    } catch {
      // ignore unreadable entries
    }
  }
  return out;
}
