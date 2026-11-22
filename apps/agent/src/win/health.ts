import fs from 'node:fs';
import os from 'node:os';
import type { HardwareHealth, SsdHealth } from '@vade/protocol';
import type { Sys } from '../sys';
import { EXE } from '../win/paths';

const NVIDIA_SMI_FALLBACK = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe';

function resolveNvidiaSmi(): string | null {
  if (fs.existsSync(EXE.nvidiaSmi)) return EXE.nvidiaSmi;
  if (fs.existsSync(NVIDIA_SMI_FALLBACK)) return NVIDIA_SMI_FALLBACK;
  return null;
}

export function parseNvidiaTemp(stdout: string): number | null {
  const first = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!/^\d+(\.\d+)?$/.test(first)) return null;
  const t = Math.round(Number(first));
  return t > 0 && t < 150 ? t : null;
}

export function parseRefreshRate(stdout: string): number | null {
  let best: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const val = Number(line.trim());
    if (Number.isFinite(val) && val >= 24 && val <= 1000) {
      const hz = Math.round(val);
      if (best == null || hz > best) best = hz;
    }
  }
  return best;
}

export function parseRamTotalGb(stdout: string, fallbackBytes = os.totalmem()): number {
  const sumBytes = Number(stdout.trim());
  const bytes = Number.isFinite(sumBytes) && sumBytes > 0 ? sumBytes : fallbackBytes;
  return Math.max(1, Math.round(bytes / 1024 ** 3));
}

export function parseSsdJson(stdout: string): SsdHealth[] {
  const raw = stdout.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: SsdHealth[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const model = typeof o.Model === 'string' && o.Model.trim() ? o.Model.trim() : 'Disk';
    const healthStatus = typeof o.HealthStatus === 'string' && o.HealthStatus.trim() ? o.HealthStatus.trim() : 'Unknown';
    const wear = typeof o.Wear === 'number' && Number.isFinite(o.Wear) ? Math.max(0, Math.min(100, Math.round(o.Wear))) : null;
    const temp = typeof o.Temp === 'number' && Number.isFinite(o.Temp) && o.Temp > 0 && o.Temp < 150 ? Math.round(o.Temp) : null;
    out.push({ model, healthStatus, wearPct: wear, tempC: temp });
  }
  return out;
}

export function healthChanged(a: HardwareHealth | null, b: HardwareHealth | null): boolean {
  if (a === b) return false;
  if (!a || !b) return true;
  if (a.ramTotalGb !== b.ramTotalGb || a.refreshRateHz !== b.refreshRateHz || a.cpuTempC !== b.cpuTempC) return true;
  if ((a.gpuTempC ?? null) !== (b.gpuTempC ?? null)) {
    if (a.gpuTempC == null || b.gpuTempC == null || Math.abs(a.gpuTempC - b.gpuTempC) >= 2) return true;
  }
  if (a.ssd.length !== b.ssd.length) return true;
  return a.ssd.some(
    (d, i) =>
      d.model !== b.ssd[i].model ||
      d.healthStatus !== b.ssd[i].healthStatus ||
      d.wearPct !== b.ssd[i].wearPct ||
      d.tempC !== b.ssd[i].tempC,
  );
}

/**
 * Polls GPU temperature & monitor refresh rate every 60 s, and RAM + SSD SMART reliability every 6 h.
 * Missing sensors/tools return null silently without spamming logs.
 */
export class HealthMonitor {
  health: HardwareHealth | null = null;
  private fastTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private fastBusy = false;
  private slowBusy = false;

  private ramTotalGb = Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
  private refreshRateHz: number | null = null;
  private gpuTempC: number | null = null;
  private ssd: SsdHealth[] = [];

  constructor(
    private readonly sys: Sys,
    private readonly onChange: () => void,
  ) {}

  start(fastIntervalMs = 60_000, slowIntervalMs = 6 * 3600_000): void {
    this.stop();
    this.fastTimer = setInterval(() => void this.tickFast(), fastIntervalMs);
    this.slowTimer = setInterval(() => void this.tickSlow(), slowIntervalMs);
    this.fastTimer.unref?.();
    this.slowTimer.unref?.();
    void this.tickSlow().then(() => this.tickFast());
  }

  stop(): void {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    this.fastTimer = null;
    this.slowTimer = null;
  }

  private commit(): void {
    const next: HardwareHealth = {
      ramTotalGb: this.ramTotalGb,
      refreshRateHz: this.refreshRateHz,
      ssd: this.ssd,
      gpuTempC: this.gpuTempC,
      cpuTempC: null,
    };
    const changed = healthChanged(this.health, next);
    this.health = next;
    if (changed) this.onChange();
  }

  async tickFast(): Promise<void> {
    if (this.fastBusy) return;
    this.fastBusy = true;
    try {
      const smi = resolveNvidiaSmi();
      if (smi) {
        const r = await this.sys.exec(smi, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], 10_000, 'utf8').catch(() => null);
        this.gpuTempC = r && r.code === 0 ? parseNvidiaTemp(r.stdout) : null;
      } else {
        this.gpuTempC = null;
      }

      const mon = await this.sys
        .powershell(
          'Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { $_.CurrentRefreshRate }',
          { mutating: false, timeoutMs: 15_000 },
        )
        .catch(() => null);
      this.refreshRateHz = mon && mon.code === 0 ? parseRefreshRate(mon.stdout) : null;
      this.commit();
    } finally {
      this.fastBusy = false;
    }
  }

  async tickSlow(): Promise<void> {
    if (this.slowBusy) return;
    this.slowBusy = true;
    try {
      const ram = await this.sys
        .powershell(
          '(Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction SilentlyContinue | Measure-Object -Property Capacity -Sum).Sum',
          { mutating: false, timeoutMs: 15_000 },
        )
        .catch(() => null);
      this.ramTotalGb = parseRamTotalGb(ram && ram.code === 0 ? ram.stdout : '', os.totalmem());

      const ssdRes = await this.sys
        .powershell(
          `$disks = Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    Model = $_.FriendlyName
    HealthStatus = [string]$_.HealthStatus
    Wear = if ($rel) { $rel.Wear } else { $null }
    Temp = if ($rel) { $rel.Temperature } else { $null }
  }
}
if ($disks) { $disks | ConvertTo-Json -Compress }`,
          { mutating: false, timeoutMs: 20_000 },
        )
        .catch(() => null);
      this.ssd = ssdRes && ssdRes.code === 0 ? parseSsdJson(ssdRes.stdout) : [];
      this.commit();
    } finally {
      this.slowBusy = false;
    }
  }
}
