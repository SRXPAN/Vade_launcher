import {
  lastOccurrence,
  minutesBetween,
  nextOccurrence,
  occurrenceKey,
  parseHHMM,
  type AgentSchedule,
  type JobMode,
} from '@vade/protocol';

export interface SchedulerDeps {
  getSchedule(): AgentSchedule | null;
  getLastKey(): string | null;
  setLastKey(key: string): void;
  isBusy(): boolean;
  startJob(mode: JobMode): void;
  log(msg: string): void;
  /** Non-null = do not start now (a player is on the PC); re-checked on every tick of the catch-up window. */
  blockReason?(): string | null;
}

/**
 * Runs the night job on the agent itself at its slot, so the club does not depend on the
 * admin PC being on. Uses a wall-clock poll (not long timers) so it behaves correctly
 * after sleep/hibernation.
 */
export class AgentScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Slot that was postponed because the PC was occupied (to log only once). */
  private blockedKey: string | null = null;

  constructor(private readonly d: SchedulerDeps) {}

  start(intervalMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nextRunAt(now = new Date()): string | null {
    const s = this.d.getSchedule();
    const min = s?.enabled ? parseHHMM(s.runTime) : null;
    return min == null ? null : nextOccurrence(min, now).toISOString();
  }

  /**
   * Key of today's slot if it has already passed. Used when the schedule changes so that
   * a new/changed slot in the past does not start a job immediately (e.g. at install time
   * while a player is on the PC).
   */
  static pastSlotKey(s: AgentSchedule, now = new Date()): string | null {
    const min = parseHHMM(s.runTime);
    if (!s.enabled || min == null) return null;
    return occurrenceKey(lastOccurrence(min, now));
  }

  tick(now = new Date()): void {
    const s = this.d.getSchedule();
    if (!s?.enabled) return;
    const min = parseHHMM(s.runTime);
    if (min == null) return;
    const slot = lastOccurrence(min, now);
    const key = occurrenceKey(slot);
    if (this.d.getLastKey() === key) return;
    const late = minutesBetween(slot, now);
    if (late > s.catchUpMin) {
      if (this.blockedKey === key) {
        this.blockedKey = null;
        this.d.setLastKey(key);
        this.d.log(`Нічне обслуговування ${s.runTime} сьогодні пропущено: ПК весь час був зайнятий гравцем`);
      }
      return;
    }
    if (this.d.isBusy()) return; // try again on the next tick
    const block = this.d.blockReason?.() ?? null;
    if (block) {
      if (this.blockedKey !== key) {
        this.blockedKey = key;
        this.d.log(`Skipped: PC is occupied by a player (${block}). Steam не закривається; повторна перевірка до ${s.catchUpMin} хв після ${s.runTime}`);
      }
      return;
    }
    const wasBlocked = this.blockedKey === key;
    this.blockedKey = null;
    this.d.setLastKey(key);
    if (wasBlocked) this.d.log('ПК звільнився — запускаю відкладене обслуговування');
    this.d.log(late >= 1 ? `Запуск за розкладом ${s.runTime} (із запізненням ${Math.round(late)} хв)` : `Запуск за розкладом ${s.runTime}`);
    this.d.startJob('scheduled');
  }
}
