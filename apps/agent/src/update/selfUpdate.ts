/**
 * OTA self-update of the installed agent.
 *
 *  1. download the new VadeAgent.exe to VadeAgent.new.exe while computing sha256;
 *     a wrong hash deletes the file and aborts (nothing is replaced);
 *  2. a helper runs as a one-shot SYSTEM scheduled task — NOT as a child of the agent, because the
 *     service wrapper kills the agent's process tree when the service stops;
 *  3. the helper stops the service, keeps VadeAgent.old.exe, moves the new file in, starts the service
 *     and waits for the new version's "started" marker; no marker within 60 s -> roll back.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ERR_HASH } from '@vade/protocol';
import type { Sys } from '../sys';
import { AgentError } from '../util';

export const SERVICE_ID = 'VadeAgent';
export const UPDATE_TASK_PATH = '\\VadeAgent\\';
export const UPDATE_TASK_NAME = 'VadeAgent Update';
const MAX_BYTES = 400 * 1024 * 1024;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Streams url -> dest and verifies sha256. On any problem dest is removed and an error is thrown,
 * so a half-downloaded or tampered file can never be installed.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expectedSha256: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ bytes: number }> {
  const expected = expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Некоректний sha256');
  await fsp.rm(dest, { force: true });
  const hash = createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(dest);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`завантаження: HTTP ${res.status}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > (opts.maxBytes ?? MAX_BYTES)) throw new Error('файл завеликий');
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== expected) throw new AgentError(`sha256 не збігається (очікувався ${expected.slice(0, 12)}…, отримано ${actual.slice(0, 12)}…) — оновлення скасовано`, ERR_HASH);
    const head = Buffer.alloc(2);
    const fd = await fsp.open(dest, 'r');
    await fd.read(head, 0, 2, 0);
    await fd.close();
    if (head.toString('latin1') !== 'MZ') throw new Error('завантажений файл не є .exe');
    return { bytes };
  } catch (e) {
    out.destroy();
    await fsp.rm(dest, { force: true }).catch(() => undefined);
    throw e;
  }
}

export interface ServicePaths {
  installDir: string;
  exe: string;
  newExe: string;
  oldExe: string;
}

/** Only the installed single-executable service can replace itself (not `node agent.cjs`). */
export function installedServicePaths(execPath = process.execPath): ServicePaths | null {
  if (path.basename(execPath).toLowerCase() !== 'vadeagent.exe') return null;
  const installDir = path.dirname(execPath);
  if (!fs.existsSync(path.join(installDir, 'VadeAgentService.exe'))) return null;
  return {
    installDir,
    exe: execPath,
    newExe: path.join(installDir, 'VadeAgent.new.exe'),
    oldExe: path.join(installDir, 'VadeAgent.old.exe'),
  };
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The helper (no here-strings inside: it is embedded in one by launchUpdateHelper). */
export function updateHelperScript(p: { installDir: string; dataDir: string; fromVersion: string; toVersion: string }): string {
  return `$ErrorActionPreference = 'Continue'
$installDir = ${psQuote(p.installDir)}
$dataDir = ${psQuote(p.dataDir)}
$from = ${psQuote(p.fromVersion)}
$to = ${psQuote(p.toVersion)}
$service = '${SERVICE_ID}'
$exe = Join-Path $installDir 'VadeAgent.exe'
$new = Join-Path $installDir 'VadeAgent.new.exe'
$old = Join-Path $installDir 'VadeAgent.old.exe'
$updDir = Join-Path $dataDir 'update'
$marker = Join-Path $updDir 'started.json'
$result = Join-Path $updDir 'result.json'
$logFile = Join-Path $dataDir 'logs\\update.log'
New-Item -ItemType Directory -Force -Path $updDir | Out-Null
function Write-UpdateLog([string]$m) { Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m) }
function Save-Result([bool]$ok, [string]$msg) {
  $json = [ordered]@{ ok = $ok; from = $from; to = $to; at = (Get-Date).ToString('o'); message = $msg } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($result, $json)
}
function Wait-AgentStopped {
  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Process -Name 'VadeAgent' -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  Get-Process -Name 'VadeAgent' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
}
function Wait-AgentStarted([string]$version) {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path -LiteralPath $marker)) { continue }
    try { $m = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { continue }
    if ([string]$m.version -ne $version) { continue }
    Start-Sleep -Seconds 5
    if ((Get-Service -Name $service).Status -eq 'Running') { return $true }
  }
  return $false
}

Start-Sleep -Seconds 3
Write-UpdateLog ('update ' + $from + ' -> ' + $to + ': stopping the service')
Stop-Service -Name $service -Force -ErrorAction SilentlyContinue
Wait-AgentStopped
try {
  Copy-Item -LiteralPath $exe -Destination $old -Force -ErrorAction Stop
  Move-Item -LiteralPath $new -Destination $exe -Force -ErrorAction Stop
} catch {
  Write-UpdateLog ('replace failed: ' + $_.Exception.Message)
  Save-Result $false ('не вдалося замінити VadeAgent.exe: ' + $_.Exception.Message)
  Start-Service -Name $service -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
Start-Service -Name $service -ErrorAction SilentlyContinue
if (Wait-AgentStarted $to) {
  Write-UpdateLog ('version ' + $to + ' is running')
  Save-Result $true ('оновлено ' + $from + ' -> ' + $to)
} else {
  Write-UpdateLog ('version ' + $to + ' did not start: rolling back to ' + $from)
  Stop-Service -Name $service -Force -ErrorAction SilentlyContinue
  Wait-AgentStopped
  Copy-Item -LiteralPath $old -Destination $exe -Force
  Start-Service -Name $service -ErrorAction SilentlyContinue
  Save-Result $false ('версія ' + $to + ' не стартувала — повернуто ' + $from)
}
Unregister-ScheduledTask -TaskPath '${UPDATE_TASK_PATH}' -TaskName '${UPDATE_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
`;
}

/** PowerShell run by the agent: registers the helper as a one-shot SYSTEM task and starts it. */
export function launchHelperScript(helper: string): string {
  return `$ErrorActionPreference = 'Stop'
$helper = @'
${helper}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))
$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskPath '${UPDATE_TASK_PATH}' -TaskName '${UPDATE_TASK_NAME}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskPath '${UPDATE_TASK_PATH}' -TaskName '${UPDATE_TASK_NAME}'
`;
}

export async function launchUpdateHelper(sys: Sys, helper: string): Promise<void> {
  const r = await sys.powershell(launchHelperScript(helper), { mutating: true, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`не вдалося запустити помічника оновлення: ${r.stderr.trim().split('\n')[0]}`);
}

/** Written once the agent is fully up; the helper waits for it before declaring success. */
export function writeStartedMarker(dataDir: string, version: string): void {
  const dir = path.join(dataDir, 'update');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({ version, pid: process.pid, ts: Date.now() }));
}

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  at: string;
  message: string;
}

/** Result left by the helper (read once after the restart, then deleted). */
export function takeUpdateResult(dataDir: string): UpdateResult | null {
  const file = path.join(dataDir, 'update', 'result.json');
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as UpdateResult;
    fs.rmSync(file, { force: true });
    return r;
  } catch {
    return null;
  }
}
