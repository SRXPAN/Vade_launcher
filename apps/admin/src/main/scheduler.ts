import fs from 'node:fs';
import {
  formatHHMM,
  isPcScheduled,
  lastOccurrence,
  minutesBetween,
  nextOccurrence,
  occurrenceKey,
  parseHHMM,
  pcRunMinute,
} from '@vade/protocol';
import type { AgentHub } from './hub';
import type { MaintenanceQueue } from './maintenanceQueue';
import type { AdminStore } from './store';

/** After the slot the packet is repeated for a while: the first one can be lost. */
const RETRY_WINDOW_MIN = 10;
const RETRY_EVERY_MS = 2 * 60_000;
const MAX_ATTEMPTS = 4;

/**
 * Night scheduler of the admin PC.
 *  - staggered: `wolLeadMin` before each PC's slot a magic packet is sent if the PC is not connected;
 *    the job itself is started by the agent's own timer (works even if this app is closed).
 *  - queue: at startTime the maintenance queue starts (at most N PCs at once, WoL when it is a PC's turn).
 */
export class WolScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly sent = new Map<number, { key: string; count: number; lastAt: number }>();
  /** occurrenceKey of the last night the queue ran (or was deliberately skipped) */
  private queueKey: string | null = null;
  private queueSig: string | null = null;

  constructor(
    private readonly store: AdminStore,
    private readonly hub: AgentHub,
    private readonly queue: MaintenanceQueue | null = null,
    private readonly stateFile: string | null = null,
  ) {
    if (stateFile) {
      try {
        this.queueKey = (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { queueKey?: string }).queueKey ?? null;
      } catch {
        // first run
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(now = new Date()): void {
    const s = this.store.settings.schedule;
    // Enabling the schedule, switching to the queue or moving the start time after today's slot
    // must not start the queue right away; only an app restart may catch up a missed night.
    const sig = `${s.enabled}|${s.mode}|${s.startTime}`;
    if (this.queueSig !== sig) {
      const appStart = this.queueSig === null;
      this.queueSig = sig;
      const min = parseHHMM(s.startTime);
      if (s.mode === 'queue' && min != null && (!appStart || this.queueKey === null)) {
        this.setQueueKey(occurrenceKey(lastOccurrence(min, now)));
      }
    }
    if (!s.enabled) return;
    if (s.mode === 'queue') this.tickQueue(now);
    else this.tickStaggered(now);
  }

  private setQueueKey(key: string): void {
    this.queueKey = key;
    if (this.stateFile) {
      try {
        fs.writeFileSync(this.stateFile, JSON.stringify({ queueKey: key }));
      } catch {
        // advisory
      }
    }
  }

  private tickQueue(now: Date): void {
    const s = this.store.settings.schedule;
    const min = parseHHMM(s.startTime);
    if (min == null || !this.queue) return;
    const slot = lastOccurrence(min, now);
    const key = occurrenceKey(slot);
    if (this.queueKey === key || minutesBetween(slot, now) > s.catchUpMin || this.queue.isRunning()) return;
    const { settings, pcs } = this.store;
    const ids = pcs.filter((p) => isPcScheduled(settings, p)).map((p) => p.id);
    this.setQueueKey(key);
    if (!ids.length) return;
    this.queue.start({
      pcIds: ids,
      mode: 'scheduled',
      concurrency: s.maxConcurrentUpdates,
      zoneOrder: s.zoneOrder,
      reason: `нічне обслуговування ${s.startTime}`,
    });
  }

  private tickStaggered(now: Date): void {
    const { settings, pcs } = this.store;
    for (const pc of pcs) {
      if (!isPcScheduled(settings, pc)) continue;
      const min = pcRunMinute(settings.schedule, pc.id);
      if (min == null) continue;
      const next = nextOccurrence(min, now);
      const last = lastOccurrence(min, now);
      let slot: Date | null = null;
      if (minutesBetween(now, next) <= settings.schedule.wolLeadMin) slot = next;
      else if (minutesBetween(last, now) <= RETRY_WINDOW_MIN) slot = last;
      if (!slot) continue;
      if (this.hub.runtime(pc.id).link === 'online') continue;

      const key = `${occurrenceKey(slot)}@${min}`;
      const prev = this.sent.get(pc.id);
      if (prev && prev.key === key && (prev.count >= MAX_ATTEMPTS || Date.now() - prev.lastAt < RETRY_EVERY_MS)) continue;
      const count = prev?.key === key ? prev.count + 1 : 1;
      this.sent.set(pc.id, { key, count, lastAt: Date.now() });
      void this.hub
        .wake(pc.id, `розклад ${formatHHMM(min)}, спроба ${count}/${MAX_ATTEMPTS}`)
        .catch((e) => this.hub.adminLog(pc.id, 'error', `Wake-on-LAN не надіслано: ${e instanceof Error ? e.message : e}`));
    }
  }
}
