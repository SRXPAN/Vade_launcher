import { OCCUPANCY_REASON_TITLES, OCCUPANCY_TITLES, type DetectorSettings, type Occupancy, type OccupancyReason, type PresenceInfo } from '@vade/protocol';
import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { EXE } from '../win/paths';
import { evaluateOccupancy, parseTasklistCsv, type OccupancyResult, type PresenceReport, type ProcInfo } from './evaluate';
import { PRESENCE_FRESH_MS, readPresence } from './presence';

export interface DetectorState {
  occupancy: Occupancy;
  reason: OccupancyReason;
  detail?: string;
  presence: PresenceInfo | null;
}

export interface DetectorDeps {
  sys: Sys;
  log: Logger;
  presenceDir: string;
  getSettings(): DetectorSettings;
  onChange(): void;
  /** Called when occupancy itself changes (free / occupied / unknown) */
  onTransition?(prev: Occupancy, next: Occupancy): void;
}

export async function listProcesses(sys: Sys): Promise<ProcInfo[] | null> {
  const r = await sys.exec(EXE.tasklist, ['/fo', 'csv', '/nh'], 20_000);
  if (r.code !== 0) return null;
  const procs = parseTasklistCsv(r.stdout);
  return procs.length ? procs : null;
}

function buildDetail(r: OccupancyResult, p: PresenceReport | null): string {
  const parts: string[] = [];
  if (r.game) parts.push(r.game);
  if (p) {
    if (p.user) parts.push(p.user);
    if (p.idleMs >= 0) parts.push(`без дій ${Math.floor(p.idleMs / 60_000)} хв`);
    if (!r.game && p.fgProc) parts.push(`вікно ${p.fgProc}`);
  } else if (r.reason === 'no_input_data') parts.push('репортер сесії гравця не відповідає');
  return parts.join(' · ');
}

/**
 * Re-evaluates occupancy every 10 s. The player's session report is cheap to read; the
 * tasklist fallback (~0.3 s) runs only when there is no fresh report.
 */
export class OccupancyDetector {
  state: DetectorState = { occupancy: 'unknown', reason: 'no_input_data', presence: null };
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private lastGood: PresenceReport | null = null;
  private lastGame: string | undefined;
  private lastEmit = 0;

  constructor(private readonly d: DetectorDeps) {}

  start(intervalMs = 10_000): void {
    this.stop();
    this.timer = setInterval(() => {
      if (!this.inFlight) void this.tick();
    }, intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now?: number): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
    }
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    const run = this.runTick(now ?? Date.now());
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async runTick(now: number): Promise<void> {
    try {
      const settings = this.d.getSettings();
      let presence: PresenceReport | null = null;
      let procs: ProcInfo[] | null = null;
      if (settings.enabled) {
        const r = readPresence(this.d.presenceDir);
        if (r && (!this.lastGood || r.ts >= this.lastGood.ts)) this.lastGood = r;
        const g = this.lastGood;
        presence = g && now - g.ts < PRESENCE_FRESH_MS && g.ts - now < 60_000 ? g : null;
        if (!presence) procs = await listProcesses(this.d.sys);
      }
      this.apply(evaluateOccupancy({ settings, presence, procs }), presence, now);
    } catch (e) {
      this.d.log.warn(`Детектор зайнятості: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private apply(r: OccupancyResult, p: PresenceReport | null, now: number): void {
    const prev = this.state;
    const presence: PresenceInfo | null = p
      ? {
          user: p.user,
          idleSec: p.idleMs >= 0 ? Math.floor(p.idleMs / 1000) : -1,
          locked: p.locked,
          foreground: p.fgProc,
          foregroundTitle: p.fgTitle,
          ...(r.game ? { game: r.game } : {}),
        }
      : null;
    this.state = { occupancy: r.occupancy, reason: r.reason, detail: buildDetail(r, p), presence };

    const changed = prev.occupancy !== r.occupancy || prev.reason !== r.reason || this.lastGame !== r.game;
    this.lastGame = r.game;
    if (changed) {
      this.d.log.info(`Зайнятість: ${OCCUPANCY_TITLES[r.occupancy]} — ${OCCUPANCY_REASON_TITLES[r.reason]}${r.game ? ` (${r.game})` : ''}`);
    }
    if (prev.occupancy !== r.occupancy) this.d.onTransition?.(prev.occupancy, r.occupancy);
    // Diagnostics (foreground window, idle minutes) refresh at most once a minute.
    const diagChanged = prev.presence?.foreground !== presence?.foreground || prev.presence?.locked !== presence?.locked;
    if (changed || (diagChanged && now - this.lastEmit > 5_000) || now - this.lastEmit > 60_000) {
      this.lastEmit = now;
      this.d.onChange();
    }
  }
}
