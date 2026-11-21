/**
 * "Is a player sitting at this PC?" — pure decision logic, no I/O (unit tested).
 *
 * Signals, strongest first:
 *  1. a game process from the list runs in a user session, or the foreground program
 *     lives in a Steam library (…\steamapps\common\…)                     -> occupied
 *  2. SENET shell: its login/lock screen is in front                       -> free
 *                  SENET runs but its lock screen is not in front          -> occupied (client logged in)
 *  3. Windows session is locked                                            -> free
 *  4. mouse/keyboard input within idleMinutes (GetLastInputInfo)           -> occupied, else free
 * Without a report from the player's session: nobody logged in -> free, otherwise unknown.
 */
import type { DetectorSettings, Occupancy, OccupancyReason } from '@vade/protocol';

/** One process from `tasklist /fo csv /nh` */
export interface ProcInfo {
  name: string;
  session: number;
}

/** Written every 5 s by the reporter running inside the player's Windows session. */
export interface PresenceReport {
  v: number;
  /** Unix ms */
  ts: number;
  session: number;
  user: string;
  /** ms since the last mouse/keyboard input, -1 if unknown */
  idleMs: number;
  /** Windows lock screen / secure desktop is active */
  locked: boolean;
  fgProc: string;
  fgPath: string;
  fgTitle: string;
  /** Executables running in this session, e.g. "cs2.exe" */
  procs: string[];
}

export interface OccupancyResult {
  occupancy: Occupancy;
  reason: OccupancyReason;
  game?: string;
}

export interface EvaluateInput {
  settings: DetectorSettings;
  /** Fresh report from the player's session, or null */
  presence: PresenceReport | null;
  /** Fallback process list (tasklist) when there is no report; null = not available */
  procs: ProcInfo[] | null;
}

/** "CS2" / "cs2.exe" -> "cs2.exe" */
export function normName(name: string): string {
  const v = name.trim().toLowerCase();
  return v.endsWith('.exe') ? v : `${v}.exe`;
}

/** The foreground program comes from a Steam library = a Steam game, whatever its name. */
export function isSteamGamePath(p: string | undefined): boolean {
  return !!p && /\\steamapps\\common\\/i.test(p);
}

export function parseTasklistCsv(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","\d+","[^"]*","(\d+)"/.exec(line);
    if (m) procs.push({ name: m[1], session: Number(m[2]) });
  }
  return procs;
}

const SHELL_PROCS = new Set(['explorer.exe', 'sihost.exe']);

export function evaluateOccupancy({ settings, presence, procs }: EvaluateInput): OccupancyResult {
  if (!settings.enabled) return { occupancy: 'unknown', reason: 'disabled' };
  const games = new Set(settings.gameProcesses.map(normName));
  const senet = new Set(settings.senetProcesses.map(normName));

  // Executables of interactive (non-service) sessions.
  const sessionProcs = presence
    ? presence.procs.map(normName)
    : procs
      ? procs.filter((p) => p.session > 0).map((p) => normName(p.name))
      : null;
  if (!sessionProcs) return { occupancy: 'unknown', reason: 'probe_failed' };

  // 1. Games: the strongest signal (also covers gamepad-only players, which GetLastInputInfo misses).
  const game =
    sessionProcs.find((n) => games.has(n)) ?? (presence && isSteamGamePath(presence.fgPath) && presence.fgProc ? normName(presence.fgProc) : undefined);
  if (game) return { occupancy: 'occupied', reason: 'game_running', game };

  const senetRunning = senet.size > 0 && (presence ? sessionProcs : (procs ?? []).map((p) => normName(p.name))).some((n) => senet.has(n));

  if (presence) {
    // 2. SENET shell.
    if (senetRunning && !presence.locked) {
      const fgIsSenet = !!presence.fgProc && senet.has(normName(presence.fgProc));
      const title = presence.fgTitle.toLowerCase();
      const isLockTitle = settings.senetLockTitles.length === 0 || settings.senetLockTitles.some((t) => t.trim() && title.includes(t.trim().toLowerCase()));
      if (fgIsSenet && isLockTitle) return { occupancy: 'free', reason: 'senet_locked' };
      return { occupancy: 'occupied', reason: 'senet_session' };
    }
    // 3. Windows lock screen.
    if (presence.locked) return { occupancy: 'free', reason: 'windows_locked' };
    // 4. Mouse / keyboard.
    if (presence.idleMs < 0) return { occupancy: 'unknown', reason: 'no_input_data' };
    if (presence.idleMs < settings.idleMinutes * 60_000) return { occupancy: 'occupied', reason: 'active_input' };
    return { occupancy: 'free', reason: 'idle' };
  }

  const loggedIn = senetRunning || sessionProcs.some((n) => SHELL_PROCS.has(n));
  if (!loggedIn) return { occupancy: 'free', reason: 'no_session' };
  return { occupancy: 'unknown', reason: 'no_input_data' };
}
