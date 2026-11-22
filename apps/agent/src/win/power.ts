import type { PowerAction } from '@vade/protocol';
import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { EXE } from './paths';

/**
 * Group Policy "Require a password when a computer wakes" (on battery / plugged in) = disabled.
 * The policy wins over the power scheme, so a CONSOLELOCK reset by Windows Update, a new
 * power plan or a user cannot bring the login prompt back. Needs SYSTEM / administrator rights.
 */
export const WAKE_PASSWORD_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\0e796bdb-100d-47d6-a2d5-f7d2daa51f51';

export const WAKE_PASSWORD_POLICY_CMDS: string[][] = ['ACSettingIndex', 'DCSettingIndex'].map((v) => [
  'add',
  WAKE_PASSWORD_POLICY_KEY,
  '/v',
  v,
  '/t',
  'REG_DWORD',
  '/d',
  '0',
  '/f',
]);

/**
 * Power policy required for unattended night work and for SENET:
 *  - hibernation available,
 *  - wake timers allowed (RTCWAKE) so the scheduled wake task can wake the PC,
 *  - NO password prompt after wake (CONSOLELOCK 0 + the HKLM policy above) so the club
 *    shell shows the client screen instead of the Windows login.
 * Idempotent, applied by the installer and on every agent (service) start.
 */
export async function applyPowerPolicy(sys: Sys, log: Logger): Promise<void> {
  const cmds: string[][] = [
    ['/hibernate', 'on'],
    ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_SLEEP', 'RTCWAKE', '1'],
    ['/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_SLEEP', 'RTCWAKE', '1'],
    ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0'],
    ['/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0'],
    ['/setactive', 'SCHEME_CURRENT'],
  ];
  for (const args of cmds) {
    const r = await sys.mutate(EXE.powercfg, args);
    if (r.code !== 0) log.warn(`powercfg ${args.join(' ')} → код ${r.code} ${r.stderr.trim()}`);
  }
  for (const args of WAKE_PASSWORD_POLICY_CMDS) {
    const r = await sys.mutate(EXE.reg, args);
    if (r.code !== 0) log.warn(`reg ${args.join(' ')} → код ${r.code} ${r.stderr.trim()}`);
  }
}

/**
 * Real sleep (S3), not hibernation: `rundll32 powrprof.dll,SetSuspendState` hibernates when
 * hibernation is on, so SetSuspendState is called directly after enabling SeShutdownPrivilege
 * (disabled by default in the SYSTEM token).
 */
const SLEEP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace VadeAgent -Name Pwr -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int RtlAdjustPrivilege(int privilege, bool enable, bool currentThread, out bool wasEnabled);
[DllImport("powrprof.dll", SetLastError = true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
'@
$was = $false
[void][VadeAgent.Pwr]::RtlAdjustPrivilege(19, $true, $false, [ref]$was)
if (-not [VadeAgent.Pwr]::SetSuspendState($false, $false, $false)) { exit 1 }
`;

export async function executePower(sys: Sys, action: PowerAction): Promise<void> {
  switch (action) {
    case 'sleep': {
      // Returns after the PC wakes up again.
      await sys.powershell(SLEEP_SCRIPT, { mutating: true, timeoutMs: 24 * 3600_000 });
      return;
    }
    case 'hibernate':
      await sys.mutate(EXE.shutdown, ['/h']);
      return;
    case 'shutdown':
      await sys.mutate(EXE.shutdown, ['/s', '/f', '/t', '0']);
      return;
    case 'restart':
      await sys.mutate(EXE.shutdown, ['/r', '/f', '/t', '0']);
      return;
  }
}
