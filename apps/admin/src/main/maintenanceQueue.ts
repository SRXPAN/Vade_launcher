import { EventEmitter } from 'node:events';
import { ERR_OCCUPIED, orderQueue, type JobMode, type LogLevel, type PcRecord, type PcRuntime } from '@vade/protocol';
import type { QueueRunStatus } from '../shared/api';
import { WorkQueue, type WorkerContext, type WorkerResult } from './workQueue';

/** What the queue needs from the agent hub (an interface, so the queue is unit-testable). */
export interface QueueHost {
  pcs(): PcRecord[];
  runtime(id: number): PcRuntime;
  wake(id: number, reason: string): Promise<void>;
  startJob(id: number, mode: JobMode, force: boolean): Promise<string>;
  waitFor(id: number, pred: (rt: PcRuntime) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  log(id: number, level: LogLevel, msg: string): void;
}

export interface QueueStartOptions {
  pcIds: number[];
  mode: JobMode;
  concurrency: number;
  zoneOrder: string[];
  reason: string;
}

export interface QueueTimeouts {
  /** Offline PC: wait this long for it to connect after Wake-on-LAN (spec: 3 min) */
  wakeTimeoutMs: number;
  /** One maintenance job (the agent itself stops after 8 h) */
  jobTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: QueueTimeouts = { wakeTimeoutMs: 3 * 60_000, jobTimeoutMs: 8.5 * 3600_000 };

/**
 * Bandwidth control: at most N PCs run maintenance (= download updates) at once.
 * Offline PCs get Wake-on-LAN when their turn comes; a PC with a player goes to the end of the
 * queue once and is skipped if still occupied.
 */
export class MaintenanceQueue extends EventEmitter<{ status: [QueueRunStatus | null] }> {
  private queue: WorkQueue<number> | null = null;
  private meta: Omit<QueueRunStatus, 'active' | 'counts' | 'items'> | null = null;
  private finishedAt: string | undefined;
  private emitTimer: NodeJS.Timeout | null = null;
  private readonly t: QueueTimeouts;

  constructor(
    private readonly host: QueueHost,
    timeouts: Partial<QueueTimeouts> = {},
  ) {
    super();
    this.t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  isRunning(): boolean {
    return !!this.queue && !this.finishedAt;
  }

  /** false when a queue is already running */
  start(o: QueueStartOptions): boolean {
    if (this.isRunning()) return false;
    const wanted = new Set(o.pcIds);
    const order = orderQueue(
      this.host.pcs().filter((p) => wanted.has(p.id)),
      o.zoneOrder,
    ).map((p) => p.id);
    const concurrency = Math.max(1, Math.min(10, Math.round(o.concurrency)));
    this.meta = { reason: o.reason, mode: o.mode, concurrency, startedAt: new Date().toISOString() };
    this.finishedAt = undefined;
    const q = new WorkQueue<number>({ keys: order, concurrency, worker: (id, ctx) => this.work(id, o.mode, ctx), maxRequeues: 1 });
    this.queue = q;
    q.on('change', () => this.emitSoon());
    for (const id of order) this.host.log(id, 'info', `Черга (${o.reason}): позиція ${order.indexOf(id) + 1} з ${order.length}, одночасно ${concurrency}`);
    void q.run().then(() => {
      this.finishedAt = new Date().toISOString();
      this.emitSoon();
    });
    this.emitSoon();
    return true;
  }

  cancel(): void {
    this.queue?.cancel();
  }

  status(): QueueRunStatus | null {
    if (!this.queue || !this.meta) return null;
    return {
      ...this.meta,
      active: !this.finishedAt,
      finishedAt: this.finishedAt,
      counts: this.queue.counts(),
      items: this.queue.items.map((i) => ({ pcId: i.key, state: i.state, message: i.message })),
    };
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('status', this.status());
    }, 200);
  }

  private async work(id: number, mode: JobMode, ctx: WorkerContext): Promise<WorkerResult> {
    const { host } = this;
    if (host.runtime(id).link !== 'online') {
      ctx.setMessage('Wake-on-LAN, чекаю підключення…');
      await host.wake(id, 'черга обслуговування').catch((e) => host.log(id, 'error', `WoL: ${e instanceof Error ? e.message : e}`));
      const up = await host.waitFor(id, (r) => r.link === 'online' && !!r.status, this.t.wakeTimeoutMs, ctx.signal);
      if (!up) throw new Error(ctx.signal.aborted ? 'скасовано' : `не підключився за ${Math.round(this.t.wakeTimeoutMs / 60_000)} хв після WoL`);
    }

    const running = host.runtime(id).status?.job;
    if (running) {
      ctx.setMessage('на ПК вже йде завдання — чекаю');
      await host.waitFor(id, (r) => !r.status?.job, this.t.jobTimeoutMs, ctx.signal);
      return { state: 'skipped', message: 'на ПК вже виконувалось завдання' };
    }

    let jobId: string;
    try {
      jobId = await host.startJob(id, mode, false);
    } catch (e) {
      if ((e as { code?: string }).code === ERR_OCCUPIED) {
        host.log(id, 'warn', 'Черга: ПК зайнятий гравцем — спроба в кінці черги');
        return { state: 'requeue', message: 'зайнятий гравцем' };
      }
      throw e;
    }
    ctx.setMessage('обслуговування…');
    const finished = await host.waitFor(id, (r) => r.status?.lastJob?.id === jobId && !!r.status.lastJob.finishedAt, this.t.jobTimeoutMs, ctx.signal);
    if (!finished) throw new Error(ctx.signal.aborted ? 'скасовано (завдання на ПК продовжується)' : 'не завершилось вчасно');
    const last = host.runtime(id).status?.lastJob;
    if (last?.result === 'errors') throw new Error(`завершено з помилками: ${last.errors}`);
    if (last?.result === 'cancelled') throw new Error('завдання скасовано на ПК');
    const min = last?.finishedAt ? Math.max(1, Math.round((Date.parse(last.finishedAt) - Date.parse(last.startedAt)) / 60_000)) : 0;
    return { state: 'done', message: `OK${min ? ` за ${min} хв` : ''}` };
  }
}
