import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentConfigPayload,
  AgentInfo,
  AgentStatus,
  DiagActionResult,
  DiagBundleResult,
  DiagNotifyArgs,
  DiagProcess,
  DiagRestartLauncherArgs,
  DiagScreenshotResult,
  ExtraUpdaterApp,
  PresenceInfo,
} from '@vade/protocol';
import type { Logger } from '../logger';
import type { AgentFileConfig, AgentStore } from '../store';
import type { Sys } from '../sys';
import { errMsg, sleep } from '../util';
import { EXE } from './paths';

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Critical Windows / Vade Agent processes that must NEVER be terminated remotely. */
export const PROTECTED_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'system',
  'idle',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'dwm.exe',
  'audiodg.exe',
  'fontdrvhost.exe',
  'sihost.exe',
  'vadeagent.exe',
  'vadeagentservice.exe',
  'memory compression',
]);

export function isProtectedProcessName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (PROTECTED_PROCESS_NAMES.has(n)) return true;
  return !n.endsWith('.exe') && PROTECTED_PROCESS_NAMES.has(`${n}.exe`);
}

function readTailText(filePath: string, maxBytes = 200_000): string {
  try {
    const st = fs.statSync(filePath);
    if (st.size === 0) return '';
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const txt = buf.toString('utf8');
      return start > 0 ? `[...обрізано перші ${start} байт...]\n${txt}` : txt;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function redactTextSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join('***REDACTED***');
  }
  return out;
}

/** Lists top processes sorted by CPU/RAM excluding protected system/agent processes. */
export async function listUserProcesses(sys: Sys): Promise<DiagProcess[]> {
  const protectedList = [...PROTECTED_PROCESS_NAMES].map(psQuote).join(',');
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$protected = @(${protectedList})
$cores = [Math]::Max(1, [Environment]::ProcessorCount)
$t1 = Get-Date
$snap1 = @{}
foreach ($p in (Get-Process)) {
  $cpu = 0.0
  try { if ($null -ne $p.CPU) { $cpu = [double]$p.CPU } } catch {}
  $snap1[$p.Id] = $cpu
}
Start-Sleep -Milliseconds 350
$t2 = Get-Date
$elapsed = [Math]::Max(0.1, ($t2 - $t1).TotalSeconds)
$out = @()
foreach ($p in (Get-Process)) {
  if ($p.SessionId -le 0) { continue }
  $exeName = ($p.ProcessName + '.exe').ToLowerInvariant()
  if ($protected -contains $exeName -or $protected -contains $p.ProcessName.ToLowerInvariant()) { continue }
  $c1 = $snap1[$p.Id]
  $c2 = 0.0
  try { if ($null -ne $p.CPU) { $c2 = [double]$p.CPU } } catch {}
  $cpuPct = 0.0
  if ($null -ne $c1 -and $c2 -ge $c1) {
    $cpuPct = [Math]::Round([Math]::Min(100.0, (($c2 - $c1) / ($elapsed * $cores)) * 100.0), 1)
  }
  $ramMb = [Math]::Round(($p.WorkingSet64 / 1MB), 1)
  $title = ''
  try { $title = [string]$p.MainWindowTitle } catch {}
  $out += [pscustomobject]@{
    pid = [int]$p.Id
    name = $p.ProcessName + '.exe'
    cpuPct = $cpuPct
    ramMb = $ramMb
    sessionId = [int]$p.SessionId
    title = $title.Substring(0, [Math]::Min(120, $title.Length))
  }
}
$sorted = @($out | Sort-Object -Property @{Expression='cpuPct';Descending=$true}, @{Expression='ramMb';Descending=$true} | Select-Object -First 60)
ConvertTo-Json -InputObject $sorted -Compress
`;
  const r = await sys.powershell(script, { mutating: false, timeoutMs: 20_000 });
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `Не вдалося отримати список процесів (код ${r.code})`);
  }
  const raw = r.stdout.trim();
  if (!raw || raw === 'null') return [];
  const parsed = JSON.parse(raw) as DiagProcess | DiagProcess[];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((p) => p && Number.isInteger(p.pid) && p.pid > 0 && !isProtectedProcessName(String(p.name ?? '')))
    .map((p) => ({
      pid: Number(p.pid),
      name: String(p.name),
      cpuPct: Number(p.cpuPct) || 0,
      ramMb: Number(p.ramMb) || 0,
      sessionId: typeof p.sessionId === 'number' ? p.sessionId : undefined,
      title: p.title ? String(p.title) : undefined,
    }));
}

/** Kills a process by PID after checking it is not a critical Windows/VadeAgent process. */
export async function killProcessSafe(sys: Sys, log: Logger, pid: number): Promise<DiagActionResult> {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 4) {
    throw new Error('Некоректний або системний PID');
  }
  if (numPid === process.pid) {
    throw new Error('Заборонено завершувати власний процес VadeAgent');
  }

  const probe = await sys.powershell(
    `$p = Get-Process -Id ${numPid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName }`,
    { mutating: false, timeoutMs: 8_000 },
  );
  const procName = probe.stdout.trim();
  if (!procName) {
    return { ok: false, message: `Процес PID ${numPid} уже завершено або не знайдено` };
  }
  if (isProtectedProcessName(procName)) {
    throw new Error(`Заборонено завершувати критичний процес: ${procName}`);
  }

  log.warn(`Діагностика: примусове завершення процесу ${procName} (PID ${numPid})`);
  const res = await sys.mutate(EXE.taskkill, ['/F', '/PID', String(numPid)]);
  if (res.code !== 0) {
    const err = res.stderr.trim() || res.stdout.trim() || `код ${res.code}`;
    return { ok: false, message: `Не вдалося завершити ${procName}: ${err}` };
  }
  return { ok: true, message: `Процес ${procName} (PID ${numPid}) завершено` };
}

/** Restarts Windows Explorer inside the active interactive user session. */
export async function restartUserExplorer(sys: Sys, log: Logger): Promise<DiagActionResult> {
  log.info('Діагностика: перезапуск explorer.exe…');
  await sys.mutate(EXE.taskkill, ['/F', '/IM', 'explorer.exe']);
  await sleep(sys.dryRun ? 100 : 1500);
  if (sys.dryRun) {
    return { ok: true, message: '[dry-run] Провідник (explorer.exe) перезапущено' };
  }

  // Check whether Windows AutoRestartShell already relaunched explorer in a user session.
  const check = await sys.powershell(
    `@((Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 })).Count`,
    { mutating: false, timeoutMs: 8_000 },
  );
  const runningCount = Number(check.stdout.trim()) || 0;
  if (runningCount > 0) {
    return { ok: true, message: 'Провідник (explorer.exe) перезапущено' };
  }

  // Launch explorer in interactive user session via scheduled task for Users group (works from Session 0).
  const launchScript = `
$ErrorActionPreference = 'Stop'
$taskPath = '\\VadeAgent\\'
$taskName = 'VadeAgent RestartExplorer'
$exp = Join-Path $env:SystemRoot 'explorer.exe'
$action = New-ScheduledTaskAction -Execute $exp
$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
try { Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName } catch {}
Start-Sleep -Seconds 2
Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
@((Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 })).Count
`;
  const r = await sys.powershell(launchScript, { mutating: true, timeoutMs: 15_000 });
  if (r.code !== 0) {
    return { ok: false, message: `Не вдалося запустити explorer.exe: ${r.stderr.trim() || `код ${r.code}`}` };
  }
  return { ok: true, message: 'Провідник (explorer.exe) перезапущено' };
}

function buildScreenshotScript(jpgPath: string, metaPath: string): string {
  return `$ErrorActionPreference = 'Stop'
$jpgPath = ${psQuote(jpgPath)}
$metaPath = ${psQuote(metaPath)}
$native = '
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, System.Text.StringBuilder info, int length, out int needed);
public static string DesktopError() {
  IntPtr d = OpenInputDesktop(0, false, 0x0100);
  if (d == IntPtr.Zero) return "Екран заблоковано або немає активного робочого столу";
  try {
    System.Text.StringBuilder name = new System.Text.StringBuilder(256);
    int needed;
    GetUserObjectInformation(d, 2, name, name.Capacity * 2, out needed);
    string n = name.ToString();
    if (!string.Equals(n, "Default", StringComparison.OrdinalIgnoreCase)) return "Активний захищений робочий стіл (" + n + ")";
    return "";
  } finally { CloseDesktop(d); }
}
'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -Namespace VadeDiag -Name ScreenNative -MemberDefinition $native
  [void][VadeDiag.ScreenNative]::SetProcessDPIAware()
  $err = [VadeDiag.ScreenNative]::DesktopError()
  if ($err) {
    [System.IO.File]::WriteAllText($metaPath, (@{ error = $err } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
    exit 0
  }
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    [System.IO.File]::WriteAllText($metaPath, (@{ error = 'Екран недоступний' } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
    exit 0
  }
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()
  $targetW = $bounds.Width
  $targetH = $bounds.Height
  if ($targetW -gt 1280) {
    $targetH = [Math]::Max(1, [int][Math]::Round($bounds.Height * (1280.0 / $bounds.Width)))
    $targetW = 1280
  }
  $outBmp = $bmp
  if ($targetW -ne $bounds.Width) {
    $outBmp = New-Object System.Drawing.Bitmap($targetW, $targetH)
    $g2 = [System.Drawing.Graphics]::FromImage($outBmp)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($bmp, 0, 0, $targetW, $targetH)
    $g2.Dispose()
    $bmp.Dispose()
  }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 60L)
  $outBmp.Save($jpgPath, $codec, $encParams)
  $outBmp.Dispose()
  [System.IO.File]::WriteAllText($metaPath, (@{ ok = $true; width = $targetW; height = $targetH } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
} catch {
  try {
    [System.IO.File]::WriteAllText($metaPath, (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  } catch {}
}
`;
}

function isRunningAsSystem(): boolean {
  return process.env.USERNAME?.toUpperCase() === 'SYSTEM' || !!process.env.USERPROFILE?.toLowerCase().includes('system32');
}

/**
 * Runs a PowerShell script inside the interactive Users session via a one-shot
 * hidden scheduled task (`conhost --headless`) and waits up to `timeoutMs` for `outPath`.
 */
async function runUsersPsTask(
  sys: Sys,
  taskName: string,
  script: string,
  outPath: string,
  mutating: boolean,
  timeoutMs = 12_000,
): Promise<void> {
  const taskPath = '\\VadeAgent\\';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const taskScript = `
$ErrorActionPreference = 'Stop'
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$args = '--headless "' + $ps + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + ${psQuote(encoded)}
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument $args
$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null
try { Start-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} } catch {}
`;
  const regRes = await sys.powershell(taskScript, { mutating, timeoutMs: 15_000 });
  if (regRes.code !== 0) {
    throw new Error(`Не вдалося запустити задачу ${taskName}: ${regRes.stderr.trim() || `код ${regRes.code}`}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !fs.existsSync(outPath)) {
    await sleep(250);
  }
  await sys
    .powershell(
      `Unregister-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
      { mutating, timeoutMs: 8_000 },
    )
    .catch(() => undefined);
}

/**
 * Captures one compressed JPEG screenshot (<=1280px, quality 60%) of the active user session.
 * When running as SYSTEM (Session 0), uses an interactive Users scheduled task just like PresenceReporter.
 */
export async function captureUserScreenshot(
  sys: Sys,
  log: Logger,
  presenceDir: string,
  presence: PresenceInfo | null,
): Promise<DiagScreenshotResult> {
  if (presence?.locked) {
    throw new Error('Екран Windows заблоковано — зняття скріншоту неможливе');
  }
  fs.mkdirSync(presenceDir, { recursive: true });
  const token = randomBytes(6).toString('hex');
  const jpgPath = path.join(presenceDir, `shot-${token}.jpg`);
  const metaPath = path.join(presenceDir, `shot-${token}.json`);
  const shotScript = buildScreenshotScript(jpgPath, metaPath);

  log.info('Діагностика: зняття скріншоту активної сесії…');
  try {
    if (!isRunningAsSystem() || sys.dryRun) {
      const r = await sys.powershell(shotScript, { mutating: false, timeoutMs: 15_000 });
      if (r.code !== 0 && !fs.existsSync(metaPath)) {
        throw new Error(r.stderr.trim() || `Помилка зняття скріншоту (код ${r.code})`);
      }
    } else {
      await runUsersPsTask(sys, 'VadeAgent Screenshot', shotScript, metaPath, false);
    }

    if (!fs.existsSync(metaPath)) {
      throw new Error('Немає активної сесії користувача або екран заблоковано');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')) as {
      ok?: boolean;
      width?: number;
      height?: number;
      error?: string;
    };
    if (meta.error || !meta.ok || !fs.existsSync(jpgPath)) {
      throw new Error(meta.error || 'Не вдалося зберегти скріншот');
    }
    const jpegBase64 = fs.readFileSync(jpgPath).toString('base64');
    return {
      jpegBase64,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      takenAt: new Date().toISOString(),
    };
  } finally {
    try { fs.rmSync(jpgPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(metaPath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Displays a non-blocking topmost popup notification in the active Windows user session
 * via WTSSendMessageW (bWait = false) with msg.exe fallback.
 */
export async function sendUserMessage(sys: Sys, log: Logger, args: DiagNotifyArgs): Promise<DiagActionResult> {
  const message = typeof args?.message === 'string' ? args.message.trim().slice(0, 1000) : '';
  if (!message) {
    throw new Error('Текст повідомлення не може бути порожнім');
  }
  const rawTitle = typeof args?.title === 'string' ? args.title.trim() : '';
  const title = (rawTitle || 'Vade Launcher').slice(0, 120);
  const rawTimeout =
    typeof args?.timeoutSec === 'number' && Number.isFinite(args.timeoutSec) ? Math.round(args.timeoutSec) : 30;
  const timeoutSec = Math.max(5, Math.min(300, rawTimeout));

  if (sys.dryRun) {
    log.info(`[dry-run] Діагностика: повідомлення "${title}" (${timeoutSec} с)`);
    return { ok: true, message: `[dry-run] Повідомлення надіслано: "${title}"` };
  }

  log.info(`Діагностика: надсилання повідомлення "${title}" (${timeoutSec} с)…`);
  const script = `
$ErrorActionPreference = 'Stop'
$title = ${psQuote(title)}
$msg = ${psQuote(message)}
$timeout = [uint32]${timeoutSec}
$native = '
[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
[DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WTSSendMessageW(IntPtr hServer, uint SessionId, string pTitle, int TitleLength, string pMessage, int MessageLength, uint Style, uint Timeout, out uint pResponse, bool bWait);
public static string Send(string title, string msg, uint timeout) {
  uint sid = WTSGetActiveConsoleSessionId();
  if (sid == 0xFFFFFFFF || sid == 0) return "NO_SESSION";
  uint resp = 0;
  bool ok = WTSSendMessageW(IntPtr.Zero, sid, title, title.Length * 2, msg, msg.Length * 2, 0x40040u, timeout, out resp, false);
  if (!ok) return "ERR:" + System.Runtime.InteropServices.Marshal.GetLastWin32Error();
  return "OK:" + sid;
}
'
Add-Type -Namespace VadeDiag -Name WtsNotifier -MemberDefinition $native
[VadeDiag.WtsNotifier]::Send($title, $msg, $timeout)
`;

  const r = await sys.powershell(script, { mutating: true, timeoutMs: 12_000 });
  const out = r.stdout.trim();
  if (r.code === 0 && out.startsWith('OK:')) {
    return { ok: true, message: `Повідомлення надіслано: "${title}"` };
  }

  if (fs.existsSync(EXE.msg)) {
    const msgRes = await sys.mutate(EXE.msg, ['*', `/TIME:${timeoutSec}`, `${title}: ${message}`], 8_000);
    if (msgRes.code === 0) {
      return { ok: true, message: `Повідомлення надіслано: "${title}"` };
    }
    const err = msgRes.stderr.trim() || msgRes.stdout.trim() || `код ${msgRes.code}`;
    return { ok: false, message: `Не вдалося надіслати повідомлення: ${err}` };
  }

  const detail = out === 'NO_SESSION' ? 'немає активної сесії користувача' : out || r.stderr.trim() || `код ${r.code}`;
  return { ok: false, message: `Не вдалося надіслати повідомлення: ${detail}` };
}

function buildRefreshRateScript(resultPath: string, targetHz: number): string {
  return `$ErrorActionPreference = 'Stop'
$resPath = ${psQuote(resultPath)}
$targetHz = [uint32]${targetHz}
$native = '
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DEVMODEW {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
  public ushort dmSpecVersion;
  public ushort dmDriverVersion;
  public ushort dmSize;
  public ushort dmDriverExtra;
  public uint dmFields;
  public int dmPositionX;
  public int dmPositionY;
  public uint dmDisplayOrientation;
  public uint dmDisplayFixedOutput;
  public short dmColor;
  public short dmDuplex;
  public short dmYResolution;
  public short dmTTOption;
  public short dmCollate;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
  public ushort dmLogPixels;
  public uint dmBitsPerPel;
  public uint dmPelsWidth;
  public uint dmPelsHeight;
  public uint dmDisplayFlags;
  public uint dmDisplayFrequency;
  public uint dmICMMethod;
  public uint dmICMIntent;
  public uint dmMediaType;
  public uint dmDitherType;
  public uint dmReserved1;
  public uint dmReserved2;
  public uint dmPanningWidth;
  public uint dmPanningHeight;
}
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettingsW(string lpszDeviceName, int iModeNum, ref DEVMODEW lpDevMode);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsW(ref DEVMODEW lpDevMode, uint dwFlags);
public static string Apply(uint targetHz) {
  DEVMODEW cur = new DEVMODEW();
  cur.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODEW));
  if (!EnumDisplaySettingsW(null, -1, ref cur)) return "ERR_ENUM";
  if (cur.dmDisplayFrequency == targetHz) return "ALREADY:" + cur.dmDisplayFrequency;
  DEVMODEW mode = new DEVMODEW();
  mode.dmSize = cur.dmSize;
  DEVMODEW best = new DEVMODEW();
  bool found = false;
  bool foundExactBpp = false;
  System.Collections.Generic.SortedSet<uint> avail = new System.Collections.Generic.SortedSet<uint>();
  int i = 0;
  while (EnumDisplaySettingsW(null, i, ref mode)) {
    if (mode.dmPelsWidth == cur.dmPelsWidth && mode.dmPelsHeight == cur.dmPelsHeight) {
      if (mode.dmDisplayFrequency > 0) avail.Add(mode.dmDisplayFrequency);
      if (mode.dmDisplayFrequency == targetHz) {
        bool sameBpp = mode.dmBitsPerPel == cur.dmBitsPerPel;
        if (!found || (sameBpp && !foundExactBpp)) {
          best = mode;
          found = true;
          foundExactBpp = sameBpp;
        }
      }
    }
    mode = new DEVMODEW();
    mode.dmSize = cur.dmSize;
    i++;
  }
  if (!found) {
    System.Collections.Generic.List<string> list = new System.Collections.Generic.List<string>();
    foreach (uint hz in avail) list.Add(hz.ToString());
    return "UNSUPPORTED:" + string.Join(", ", list.ToArray());
  }
  best.dmFields = 0x00080000u | 0x00100000u | 0x00400000u;
  if (best.dmBitsPerPel > 0) best.dmFields |= 0x00040000u;
  int rc = ChangeDisplaySettingsW(ref best, 1u);
  return "CHG:" + rc + ":" + cur.dmDisplayFrequency;
}
'
try {
  Add-Type -Namespace VadeDiag -Name DisplayHz -MemberDefinition $native
  $raw = [VadeDiag.DisplayHz]::Apply($targetHz)
  if ($raw.StartsWith('ALREADY:')) {
    $obj = @{ status = 'already'; currentHz = [int]$raw.Substring(8) }
  } elseif ($raw.StartsWith('UNSUPPORTED:')) {
    $obj = @{ status = 'unsupported'; available = $raw.Substring(12) }
  } elseif ($raw.StartsWith('CHG:')) {
    $parts = $raw.Split(':')
    $obj = @{ status = 'chg'; code = [int]$parts[1]; currentHz = [int]$parts[2] }
  } else {
    $obj = @{ status = 'error'; error = $raw }
  }
  [System.IO.File]::WriteAllText($resPath, ($obj | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
} catch {
  try {
    [System.IO.File]::WriteAllText($resPath, (@{ status = 'error'; error = $_.Exception.Message } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)
  } catch {}
}
`;
}

/**
 * Sets the primary monitor refresh rate to `targetHz` at its current resolution via Win32
 * EnumDisplaySettingsW + ChangeDisplaySettingsW (CDS_UPDATEREGISTRY).
 */
export async function restoreMonitorRefreshRate(
  sys: Sys,
  log: Logger,
  presenceDir: string,
  targetHz: number,
): Promise<DiagActionResult> {
  if (!Number.isInteger(targetHz) || targetHz < 50 || targetHz > 600) {
    throw new Error('Некоректна частота оновлення (допустимо ціле число 50..600 Гц)');
  }
  if (sys.dryRun) {
    log.info(`[dry-run] Діагностика: відновлення частоти монітора ${targetHz} Гц`);
    return { ok: true, message: `[dry-run] Частоту монітора встановлено: ${targetHz} Гц` };
  }

  fs.mkdirSync(presenceDir, { recursive: true });
  const token = randomBytes(6).toString('hex');
  const resultPath = path.join(presenceDir, `hz-${token}.json`);
  const script = buildRefreshRateScript(resultPath, targetHz);

  log.info(`Діагностика: встановлення частоти монітора ${targetHz} Гц…`);
  try {
    if (!isRunningAsSystem()) {
      const r = await sys.powershell(script, { mutating: true, timeoutMs: 15_000 });
      if (r.code !== 0 && !fs.existsSync(resultPath)) {
        return { ok: false, message: r.stderr.trim() || `Не вдалося змінити частоту (код ${r.code})` };
      }
    } else {
      await runUsersPsTask(sys, 'VadeAgent RefreshRate', script, resultPath, true);
    }

    if (!fs.existsSync(resultPath)) {
      return { ok: false, message: 'Немає активної сесії користувача або не вдалося отримати доступ до дисплея' };
    }
    const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) as {
      status?: string;
      currentHz?: number;
      available?: string;
      code?: number;
      error?: string;
    };

    if (parsed.status === 'already') {
      return { ok: true, message: `Вже встановлено ${targetHz} Гц` };
    }
    if (parsed.status === 'unsupported') {
      return {
        ok: false,
        message: `Монітор не підтримує ${targetHz} Гц (доступно: ${parsed.available || 'немає даних'} Гц)`,
      };
    }
    if (parsed.status === 'chg') {
      if (parsed.code === 0) {
        return { ok: true, message: `Частоту монітора змінено: ${parsed.currentHz ?? '?'} → ${targetHz} Гц` };
      }
      if (parsed.code === 1) {
        return { ok: true, message: `Частоту ${targetHz} Гц застосовано (потрібен перезапуск)` };
      }
      return { ok: false, message: `Не вдалося змінити частоту на ${targetHz} Гц (код ${parsed.code ?? '?'})` };
    }
    return { ok: false, message: parsed.error || `Не вдалося змінити частоту на ${targetHz} Гц` };
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch { /* ignore */ }
  }
}

function resolveRiotExePath(extraApps?: ExtraUpdaterApp[]): string {
  const apps = extraApps ?? [];
  const matches = apps.filter(
    (a) => !!a.exePath?.trim() && (a.id === 'riot' || /riot/i.test(a.name) || /riot/i.test(a.exePath)),
  );
  const preferred = matches.find((a) => a.enabled) ?? matches[0];
  return preferred?.exePath.trim() || 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
}

/**
 * Force-terminates Steam or Riot Client processes and relaunches the client in the active user session.
 */
export async function restartUserLauncher(
  sys: Sys,
  log: Logger,
  args: DiagRestartLauncherArgs,
  steamPath: string,
  extraApps?: ExtraUpdaterApp[],
): Promise<DiagActionResult> {
  if (args?.app !== 'steam' && args?.app !== 'riot') {
    throw new Error('Некоректний лаунчер (допустимо steam або riot)');
  }

  const isSteam = args.app === 'steam';
  const title = isSteam ? 'Steam' : 'Riot Client';
  const procs = isSteam
    ? ['steam.exe', 'steamwebhelper.exe']
    : ['RiotClientServices.exe', 'RiotClientUx.exe', 'RiotClientUxRender.exe'];
  const exePath = isSteam
    ? path.win32.join(steamPath.trim() || 'C:\\Program Files (x86)\\Steam', 'steam.exe')
    : resolveRiotExePath(extraApps);
  const launchArgs = isSteam ? '-silent' : '';

  if (sys.dryRun) {
    log.info(`[dry-run] Діагностика: перезапуск ${title} (${exePath})`);
    return { ok: true, message: `[dry-run] Перезапущено ${title}` };
  }

  if (!fs.existsSync(exePath)) {
    return { ok: false, message: `Не знайдено файл: ${exePath}` };
  }

  log.info(`Діагностика: перезапуск ${title}…`);
  for (const proc of procs) {
    await sys.mutate(EXE.taskkill, ['/F', '/T', '/IM', proc], 8_000);
  }
  await sleep(1200);

  const workDir = path.win32.dirname(exePath);
  if (!isRunningAsSystem()) {
    const argPart = launchArgs ? ` -ArgumentList ${psQuote(launchArgs)}` : '';
    const r = await sys.powershell(
      `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${psQuote(exePath)} -WorkingDirectory ${psQuote(workDir)}${argPart}`,
      { mutating: true, timeoutMs: 12_000 },
    );
    if (r.code !== 0) {
      return { ok: false, message: `Не вдалося запустити ${title}: ${r.stderr.trim() || `код ${r.code}`}` };
    }
    return { ok: true, message: `${title} перезапущено` };
  }

  const taskPath = '\\VadeAgent\\';
  const taskName = 'VadeAgent Relaunch';
  const argLine = launchArgs ? ` -Argument ${psQuote(launchArgs)}` : '';
  const taskScript = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute ${psQuote(exePath)} -WorkingDirectory ${psQuote(workDir)}${argLine}
$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null
try {
  Start-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)}
  Start-Sleep -Milliseconds 500
} finally {
  Unregister-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  const r = await sys.powershell(taskScript, { mutating: true, timeoutMs: 15_000 });
  if (r.code !== 0) {
    return { ok: false, message: `Не вдалося запустити ${title}: ${r.stderr.trim() || `код ${r.code}`}` };
  }
  return { ok: true, message: `${title} перезапущено` };
}

export function redactAgentConfig(fileCfg: AgentFileConfig, stateCfg: AgentConfigPayload | null): Record<string, unknown> {
  return {
    fileConfig: {
      ...fileCfg,
      clubKey: fileCfg.clubKey ? '***REDACTED***' : '',
    },
    pushedConfig: stateCfg,
  };
}

/** Collects logs, steamcmd output, system info, and secret-redacted config from this agent. */
export function collectAgentDiagnostics(deps: {
  dataDir: string;
  store: AgentStore;
  log: Logger;
  info: AgentInfo;
  status: AgentStatus;
}): DiagBundleResult {
  const { dataDir, store, log, info, status } = deps;
  const secrets = [store.file.clubKey];

  let agentLog = readTailText(path.join(dataDir, 'logs', 'agent.log'), 200_000);
  if (!agentLog) {
    agentLog = log
      .history(1000)
      .map((l) => `[${l.ts}] ${l.level.toUpperCase()} ${l.msg}`)
      .join('\n');
  }
  const steamcmdLast = readTailText(path.join(dataDir, 'steamcmd-last.txt'), 200_000);

  return {
    collectedAt: new Date().toISOString(),
    hostname: info.hostname,
    agentVersion: info.version,
    os: info.os,
    agentConfig: redactAgentConfig(store.file, store.state.config),
    agentLog: redactTextSecrets(agentLog, secrets),
    steamcmdLast: redactTextSecrets(steamcmdLast, secrets),
    systemInfo: {
      nodeVersion: process.version,
      arch: process.arch,
      platform: process.platform,
      uptimeSec: Math.round(os.uptime()),
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      cpus: os.cpus().length,
      nics: info.nics,
      disks: status.disks ?? [],
      health: status.health ?? null,
      occupancy: status.occupancy,
      occupancyReason: status.occupancyReason,
      steamcmdInstalled: status.steamcmdInstalled,
      dryRun: status.dryRun,
      execPath: errMsg(process.execPath),
    },
  };
}
