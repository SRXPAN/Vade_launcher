import fsp from 'node:fs/promises';
import type { DiskInfo } from '@vade/protocol';
import type { Sys } from '../sys';

/** Local fixed disks (DriveType 3): no USB sticks, DVDs or network drives. */
export async function listFixedDrives(sys: Sys): Promise<string[]> {
  const r = await sys.powershell(
    "(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }) -join ','",
    { mutating: false, timeoutMs: 30_000 },
  );
  const drives = r.code === 0 ? r.stdout.trim().split(',').map((d) => d.trim().toUpperCase()).filter((d) => /^[A-Z]:$/.test(d)) : [];
  if (drives.length) return drives;
  // Fallback without WMI: every letter that answers statfs (C: .. Z:)
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:`;
    if ((await readDisk(d)) != null) out.push(d);
  }
  return out;
}

export async function readDisk(drive: string): Promise<DiskInfo | null> {
  try {
    const s = await fsp.statfs(`${drive}\\`);
    const totalBytes = s.blocks * s.bsize;
    if (!totalBytes) return null;
    return { drive, freeBytes: s.bavail * s.bsize, totalBytes };
  } catch {
    return null;
  }
}

/** True when a drive appeared/disappeared or its free space moved by more than `thresholdBytes`. */
export function disksChanged(a: DiskInfo[], b: DiskInfo[], thresholdBytes = 512 * 1024 ** 2): boolean {
  if (a.length !== b.length) return true;
  return a.some((d, i) => d.drive !== b[i].drive || Math.abs(d.freeBytes - b[i].freeBytes) > thresholdBytes);
}

/** Reads free space every minute (statfs, no process spawn); the drive list every 10 minutes. */
export class DiskMonitor {
  disks: DiskInfo[] = [];
  private drives: string[] = [];
  private drivesAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly sys: Sys,
    private readonly onChange: () => void,
  ) {}

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.drives.length || Date.now() - this.drivesAt > 10 * 60_000) {
        this.drives = await listFixedDrives(this.sys);
        this.drivesAt = Date.now();
      }
      const next: DiskInfo[] = [];
      for (const d of this.drives) {
        const info = await readDisk(d);
        if (info) next.push(info);
      }
      const changed = disksChanged(this.disks, next);
      this.disks = next;
      if (changed) this.onChange();
    } finally {
      this.busy = false;
    }
  }
}
