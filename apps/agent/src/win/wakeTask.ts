import { formatHHMM, parseHHMM, type AgentSchedule } from '@vade/protocol';
import type { Logger } from '../logger';
import type { Sys } from '../sys';

const TASK_PATH = '\\VadeAgent\\';
const TASK_NAME = 'VadeAgent Wake';

/**
 * A do-nothing scheduled task with WakeToRun: Windows programs an RTC wake timer for it,
 * so a sleeping/hibernated PC wakes up by itself shortly before its night slot even when
 * the admin PC is off. (A fully powered-off PC still needs Wake-on-LAN from the admin app.)
 */
export async function syncWakeTask(sys: Sys, log: Logger, schedule: AgentSchedule | null): Promise<void> {
  const runMinute = schedule?.enabled ? parseHHMM(schedule.runTime) : null;
  if (runMinute == null) {
    await sys.powershell(
      `Unregister-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
      { mutating: true },
    );
    return;
  }
  const wakeAt = formatHHMM(runMinute - Math.max(1, schedule!.wakeLeadMin));
  const script = `
$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\cmd.exe" -Argument '/c exit 0'
$t = New-ScheduledTaskTrigger -Daily -At '${wakeAt}'
$s = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
`;
  const r = await sys.powershell(script, { mutating: true });
  if (r.code !== 0) log.warn(`Не вдалося створити таймер пробудження: ${r.stderr.trim().split('\n')[0]}`);
  else log.info(`Таймер пробудження (RTC) встановлено на ${wakeAt}`);
}
