import type { Logger } from '../logger';
import type { AgentStore } from '../store';
import type { Sys } from '../sys';

export const DEFENDER_EXCLUSION_PATHS = ['C:\\Program Files\\VadeAgent', 'C:\\ProgramData\\VadeAgent'] as const;

export function defenderExclusionScript(paths: readonly string[] = DEFENDER_EXCLUSION_PATHS): string {
  const quoted = paths.map((p) => `"${p.replace(/"/g, '`"')}"`).join(', ');
  return `try {
  Add-MpPreference -ExclusionPath ${quoted} -ErrorAction Stop
  Write-Output 'OK'
} catch {
  Write-Output ('SKIP: ' + $_.Exception.Message)
}`;
}

/**
 * Asynchronously adds VadeAgent program and data folders to Windows Defender exclusions
 * once per agent version so OTA self-updates on already installed PCs are not quarantined.
 * Never throws: if Defender is disabled or replaced by a 3rd-party AV, logs at warn level.
 */
export async function ensureDefenderExclusions(
  sys: Sys,
  log: Logger,
  store: AgentStore,
  version: string,
): Promise<boolean> {
  if (store.state.defenderExcludedVersion === version) return true;
  try {
    const r = await sys.powershell(defenderExclusionScript(), { mutating: true, timeoutMs: 30_000 });
    const out = r.stdout.trim();
    store.state.defenderExcludedVersion = version;
    store.saveState();
    if (r.code === 0 && (out === 'OK' || (sys.dryRun && !out))) {
      log.info(`Windows Defender: додано винятки для ${DEFENDER_EXCLUSION_PATHS.join(', ')}`);
      return true;
    }
    const reason = (out.replace(/^SKIP:\s*/i, '') || r.stderr.trim() || `код ${r.code}`).split(/\r?\n/)[0];
    log.warn(`Windows Defender: винятки пропущено (${reason})`);
    return false;
  } catch (e) {
    store.state.defenderExcludedVersion = version;
    store.saveState();
    log.warn(`Windows Defender: винятки пропущено (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}
