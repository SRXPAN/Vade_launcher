/**
 * The agent runs as SYSTEM in session 0, where GetLastInputInfo and the foreground window
 * of the player are not visible. A tiny reporter therefore runs INSIDE the player's session
 * and writes <dataDir>\presence\session-<id>.json every 5 s.
 *
 *  - service:  a Task Scheduler task for the Users group (at logon + every 5 min, one instance),
 *              started through `conhost --headless`, so no window ever flashes over a game;
 *  - dev/dry-run: the agent runs the reporter itself as a child process (same user session).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { EXE } from '../win/paths';
import type { PresenceReport } from './evaluate';

export const PRESENCE_TASK_PATH = '\\VadeAgent\\';
export const PRESENCE_TASK_NAME = 'VadeAgent Presence';
/** A report older than this is ignored (the reporter writes every 5 s). */
export const PRESENCE_FRESH_MS = 30_000;
const USERS_SID = 'S-1-5-32-545';

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * PowerShell script of the reporter. parentPid > 0: exit when that process is gone (child mode).
 * It contains no here-string and no single quote inside the C# block, so it can itself be
 * embedded in a here-string (see presenceTaskScript).
 */
export function reporterScript(outDir: string, parentPid = 0): string {
  return `$ErrorActionPreference = 'SilentlyContinue'
$outDir = ${psQuote(outDir)}
$parent = ${Math.max(0, Math.floor(parentPid))}
$native = '
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
[DllImport("kernel32.dll")] static extern uint GetTickCount();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, System.Text.StringBuilder info, int length, out int needed);
public static long IdleMs() {
  LASTINPUTINFO li = new LASTINPUTINFO();
  li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
  if (!GetLastInputInfo(ref li)) return -1;
  return (long)unchecked(GetTickCount() - li.dwTime);
}
public static bool Locked() {
  IntPtr d = OpenInputDesktop(0, false, 0x0100);
  if (d == IntPtr.Zero) return true;
  try {
    System.Text.StringBuilder name = new System.Text.StringBuilder(256);
    int needed;
    GetUserObjectInformation(d, 2, name, name.Capacity * 2, out needed);
    return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
  } finally { CloseDesktop(d); }
}
'
Add-Type -Namespace VadePresence -Name Native -MemberDefinition $native
$sid =[System.Diagnostics.Process]::GetCurrentProcess().SessionId
$file = Join-Path $outDir ('session-' + $sid + '.json')
$tmp = $file + '.tmp'
while ($true) {
  if ($parent -gt 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
  try {
    $h = [VadePresence.Native]::GetForegroundWindow()
    [uint32]$fgPid = 0
    [void][VadePresence.Native]::GetWindowThreadProcessId($h, [ref]$fgPid)
    $title = New-Object System.Text.StringBuilder 512
    [void][VadePresence.Native]::GetWindowText($h, $title, 512)
    $all = [System.Diagnostics.Process]::GetProcesses()
    $mine = @($all | Where-Object { $_.SessionId -eq $sid } | ForEach-Object { $_.ProcessName + '.exe' } | Sort-Object -Unique)
    $fg = $all | Where-Object { $_.Id -eq $fgPid } | Select-Object -First 1
    $fgPath = ''
    if ($fg) { try { $fgPath = $fg.MainModule.FileName } catch { $fgPath = '' } }
    $report = [ordered]@{
      v = 1
      ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      session = $sid
      user = [string]$env:USERNAME
      idleMs = [VadePresence.Native]::IdleMs()
      locked = [VadePresence.Native]::Locked()
      fgProc = $(if ($fg) { $fg.ProcessName + '.exe' } else { '' })
      fgPath = [string]$fgPath
      fgTitle = $title.ToString()
      procs = $mine
    }
    [System.IO.File]::WriteAllText($tmp, ($report | ConvertTo-Json -Compress -Depth 3))
    Move-Item -LiteralPath $tmp -Destination $file -Force
  } catch { }
  Start-Sleep -Seconds 5
}
`;
}

/** PowerShell (run as SYSTEM) that registers the reporter task for every user of this PC. */
export function presenceTaskScript(outDir: string): string {
  return `$ErrorActionPreference = 'Stop'
$reporter = @'
${reporterScript(outDir)}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($reporter))
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$arguments = '--headless "' + $ps + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $encoded
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument $arguments
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -GroupId '${USERS_SID}' -RunLevel Limited
Register-ScheduledTask -TaskPath '${PRESENCE_TASK_PATH}' -TaskName '${PRESENCE_TASK_NAME}' -Action $action -Trigger @($atLogon, $every5) -Settings $settings -Principal $principal -Force | Out-Null
try { Start-ScheduledTask -TaskPath '${PRESENCE_TASK_PATH}' -TaskName '${PRESENCE_TASK_NAME}' } catch { }
`;
}

/** Newest session report in `dir` (whatever its age; the caller checks freshness). */
export function readPresence(dir: string): PresenceReport | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^session-\d+\.json$/i.test(n));
  } catch {
    return null;
  }
  let best: PresenceReport | null = null;
  for (const n of names) {
    try {
      const file = path.join(dir, n);
      if (fs.statSync(file).size > 256 * 1024) continue;
      const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<PresenceReport>;
      if (typeof r.ts !== 'number' || typeof r.idleMs !== 'number') continue;
      const report: PresenceReport = {
        v: Number(r.v) || 1,
        ts: r.ts,
        session: Number(r.session) || 0,
        user: String(r.user ?? ''),
        idleMs: r.idleMs,
        locked: r.locked === true,
        fgProc: String(r.fgProc ?? ''),
        fgPath: String(r.fgPath ?? ''),
        fgTitle: String(r.fgTitle ?? '').slice(0, 300),
        procs: Array.isArray(r.procs) ? r.procs.filter((x): x is string => typeof x === 'string').slice(0, 2000) : [],
      };
      if (!best || report.ts > best.ts) best = report;
    } catch {
      // half-written file: the next tick reads it
    }
  }
  return best;
}

export type PresenceMode = 'task' | 'child' | 'off';

/** Starts the reporter in the way that fits the agent's mode. */
export class PresenceReporter {
  private child: ChildProcess | null = null;

  constructor(
    private readonly sys: Sys,
    private readonly log: Logger,
    readonly dir: string,
    private readonly mode: PresenceMode,
  ) {}

  async start(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.mode === 'off') return;
    if (this.mode === 'child') {
      this.spawnChild();
      return;
    }
    // Players' sessions must be able to write their report; the parent folder stays SYSTEM/Admins only.
    const acl = await this.sys.mutate(EXE.icacls, [this.dir, '/grant', `*${USERS_SID}:(OI)(CI)M`]);
    if (acl.code !== 0) this.log.warn(`presence: icacls → код ${acl.code}`);
    const r = await this.sys.powershell(presenceTaskScript(this.dir), { mutating: true, timeoutMs: 60_000 });
    if (r.code !== 0) this.log.warn(`Детектор: не вдалося створити задачу репортера сесії: ${r.stderr.trim().split('\n')[0]}`);
  }

  private spawnChild(): void {
    const encoded = Buffer.from(reporterScript(this.dir, process.pid), 'utf16le').toString('base64');
    try {
      this.child = spawn(EXE.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: 'ignore',
      });
      this.child.on('error', (e) => this.log.warn(`Репортер сесії: ${e.message}`));
      this.child.on('exit', () => (this.child = null));
    } catch (e) {
      this.log.warn(`Не вдалося запустити репортер сесії: ${String(e)}`);
    }
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}
