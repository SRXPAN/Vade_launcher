import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEALTH_TELEMETRY, type HealthTelemetrySettings } from '@vade/protocol';
import type { ExecResult, Sys } from '../src/sys';
import { HealthMonitor, normalizeHealthSettings } from '../src/win/health';
import { EXE } from '../src/win/paths';

function createMockSys(overrides?: {
  gpuTemp?: string;
  refreshHz?: string;
  ramBytes?: string;
  ssdJson?: string;
}) {
  const execCalls: Array<{ file: string; args: string[] }> = [];
  const psScripts: string[] = [];

  const exec = vi.fn(async (file: string, args: string[]): Promise<ExecResult> => {
    execCalls.push({ file, args });
    return { code: 0, stdout: overrides?.gpuTemp ?? '62\n', stderr: '' };
  });

  const powershell = vi.fn(async (script: string): Promise<ExecResult> => {
    psScripts.push(script);
    if (script.includes('Win32_VideoController')) {
      return { code: 0, stdout: overrides?.refreshHz ?? '240\n', stderr: '' };
    }
    if (script.includes('Win32_PhysicalMemory')) {
      return { code: 0, stdout: overrides?.ramBytes ?? String(32 * 1024 ** 3), stderr: '' };
    }
    if (script.includes('Get-PhysicalDisk')) {
      return {
        code: 0,
        stdout:
          overrides?.ssdJson ??
          JSON.stringify([{ Model: 'Samsung 980 PRO', HealthStatus: 'Healthy', Wear: 4, Temp: 41 }]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  });

  const sys = { exec, powershell } as unknown as Sys;
  return { sys, exec, powershell, execCalls, psScripts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Module 6: normalizeHealthSettings', () => {
  it('applies defaults and clamps pollIntervalSec to [30, 600]', () => {
    expect(normalizeHealthSettings(null)).toEqual(DEFAULT_HEALTH_TELEMETRY);
    expect(normalizeHealthSettings(undefined)).toEqual(DEFAULT_HEALTH_TELEMETRY);
    expect(normalizeHealthSettings({ pollIntervalSec: 5 })).toEqual({
      ...DEFAULT_HEALTH_TELEMETRY,
      pollIntervalSec: 30,
    });
    expect(normalizeHealthSettings({ pollIntervalSec: 3600 })).toEqual({
      ...DEFAULT_HEALTH_TELEMETRY,
      pollIntervalSec: 600,
    });
    expect(normalizeHealthSettings({ enabled: false, collectTemps: false, collectSmart: false, pollIntervalSec: 120 })).toEqual({
      enabled: false,
      pollIntervalSec: 120,
      collectTemps: false,
      collectSmart: false,
    });
  });
});

describe('Module 6: HealthMonitor flexible telemetry controls', () => {
  it('makes 0 exec/powershell calls and keeps health null when enabled is false', async () => {
    vi.useFakeTimers();
    const { sys, exec, powershell } = createMockSys();
    const onChange = vi.fn();
    const settings: HealthTelemetrySettings = {
      enabled: false,
      pollIntervalSec: 30,
      collectTemps: true,
      collectSmart: true,
    };

    const monitor = new HealthMonitor(sys, onChange, () => settings);
    monitor.start();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(exec).not.toHaveBeenCalled();
    expect(powershell).not.toHaveBeenCalled();
    expect(monitor.health).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await monitor.tickFast();
    await monitor.tickSlow();
    expect(exec).not.toHaveBeenCalled();
    expect(powershell).not.toHaveBeenCalled();
    expect(monitor.health).toBeNull();
    monitor.stop();
  });

  it('skips nvidia-smi when collectTemps is false while still polling monitor refresh rate', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === EXE.nvidiaSmi);
    const { sys, exec, psScripts } = createMockSys({ gpuTemp: '68\n', refreshHz: '144\n' });
    const onChange = vi.fn();
    let settings: HealthTelemetrySettings = {
      enabled: true,
      pollIntervalSec: 60,
      collectTemps: false,
      collectSmart: true,
    };

    const monitor = new HealthMonitor(sys, onChange, () => settings);
    await monitor.tickFast();

    expect(exec).not.toHaveBeenCalled();
    expect(psScripts.some((s) => s.includes('Win32_VideoController'))).toBe(true);
    expect(monitor.health?.gpuTempC).toBeNull();
    expect(monitor.health?.refreshRateHz).toBe(144);

    // Enabling collectTemps queries nvidia-smi
    settings = { ...settings, collectTemps: true };
    await monitor.tickFast();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(monitor.health?.gpuTempC).toBe(68);
  });

  it('skips Get-PhysicalDisk SMART PowerShell when collectSmart is false while still collecting RAM', async () => {
    const { sys, psScripts } = createMockSys({ ramBytes: String(64 * 1024 ** 3) });
    const onChange = vi.fn();
    let settings: HealthTelemetrySettings = {
      enabled: true,
      pollIntervalSec: 60,
      collectTemps: true,
      collectSmart: false,
    };

    const monitor = new HealthMonitor(sys, onChange, () => settings);
    await monitor.tickSlow();

    expect(psScripts.some((s) => s.includes('Win32_PhysicalMemory'))).toBe(true);
    expect(psScripts.some((s) => s.includes('Get-PhysicalDisk'))).toBe(false);
    expect(monitor.health?.ramTotalGb).toBe(64);
    expect(monitor.health?.ssd).toEqual([]);

    // Enabling collectSmart runs SMART query
    settings = { ...settings, collectSmart: true };
    await monitor.tickSlow();
    expect(psScripts.some((s) => s.includes('Get-PhysicalDisk'))).toBe(true);
    expect(monitor.health?.ssd).toHaveLength(1);
    expect(monitor.health?.ssd[0].model).toBe('Samsung 980 PRO');
  });

  it('respects pollIntervalSec and updates cadence/disable dynamically via reconfigure()', async () => {
    vi.useFakeTimers();
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === EXE.nvidiaSmi);
    const { sys, exec, psScripts } = createMockSys({ gpuTemp: '65\n', refreshHz: '240\n' });
    const onChange = vi.fn();

    let settings: HealthTelemetrySettings = {
      enabled: true,
      pollIntervalSec: 30,
      collectTemps: true,
      collectSmart: true,
    };
    const countFastPolls = () => psScripts.filter((s) => s.includes('Win32_VideoController')).length;

    const monitor = new HealthMonitor(sys, onChange, () => settings);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.health).not.toBeNull();
    expect(monitor.health?.gpuTempC).toBe(65);
    expect(monitor.health?.ssd).toHaveLength(1);
    expect(countFastPolls()).toBe(1);

    // 29s: no second poll yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(countFastPolls()).toBe(1);

    // 30s: second poll fires
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countFastPolls()).toBe(2);

    // Reconfigure to 120s interval
    settings = { ...settings, pollIntervalSec: 120 };
    monitor.reconfigure();
    await vi.advanceTimersByTimeAsync(0);
    expect(countFastPolls()).toBe(3);

    // At +30s and +90s, no fast poll occurs
    await vi.advanceTimersByTimeAsync(90_000);
    expect(countFastPolls()).toBe(3);

    // At +120s, fast poll fires
    await vi.advanceTimersByTimeAsync(30_000);
    expect(countFastPolls()).toBe(4);

    // Toggle collectTemps=false at same 120s interval -> clears gpuTempC without spawning nvidia-smi
    const execCallsBefore = exec.mock.calls.length;
    settings = { ...settings, collectTemps: false };
    monitor.reconfigure();
    expect(monitor.health?.gpuTempC).toBeNull();
    expect(exec.mock.calls.length).toBe(execCallsBefore);

    // Disable health telemetry -> stops timers, clears health to null, triggers onChange
    const changesBeforeDisable = onChange.mock.calls.length;
    const psBeforeDisable = psScripts.length;
    settings = { ...settings, enabled: false };
    monitor.reconfigure();

    expect(monitor.health).toBeNull();
    expect(onChange.mock.calls.length).toBe(changesBeforeDisable + 1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(exec.mock.calls.length).toBe(execCallsBefore);
    expect(psScripts.length).toBe(psBeforeDisable);
    expect(monitor.health).toBeNull();
    monitor.stop();
  });
});
