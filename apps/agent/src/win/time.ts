import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { EXE } from './paths';

/** Starts Windows Time service (w32time) if stopped and forces an NTP resync. */
export async function syncWindowsTime(
  sys: Sys,
  log: Logger,
): Promise<{ ok: boolean; agentTimeMs: number; message: string }> {
  await sys.mutate(EXE.net, ['start', 'w32time'], 15_000).catch(() => undefined);
  const r = await sys.mutate(EXE.w32tm, ['/resync', '/force'], 30_000);
  const out = (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || '';
  const ok = r.code === 0;
  const message = sys.dryRun ? '[dry-run] w32tm /resync /force' : out || (ok ? 'Час синхронізовано' : `помилка w32tm (код ${r.code})`);
  log.log(ok ? 'info' : 'warn', `Синхронізація часу (NTP): ${message}`);
  return { ok, agentTimeMs: Date.now(), message };
}
