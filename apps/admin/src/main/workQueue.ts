import { EventEmitter } from 'node:events';

export type QueueItemState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface QueueItem<K> {
  key: K;
  state: QueueItemState;
  message?: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
}

/** requeue = put the item at the end of the queue (e.g. a player is on the PC), at most maxRequeues times */
export interface WorkerResult {
  state: 'done' | 'skipped' | 'requeue';
  message?: string;
}

export interface WorkerContext {
  signal: AbortSignal;
  attempt: number;
  setMessage(msg: string): void;
}

export interface WorkQueueOptions<K> {
  keys: K[];
  /** At most this many items run at the same time */
  concurrency: number;
  worker: (key: K, ctx: WorkerContext) => Promise<WorkerResult>;
  /** An item running longer than this fails with "таймаут" */
  itemTimeoutMs?: number;
  /** How often one item may be sent to the end of the queue (default 1) */
  maxRequeues?: number;
}

export interface QueueCounts {
  running: number;
  queued: number;
  done: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/**
 * Bounded-concurrency queue: starts `concurrency` items, and every time one settles (done, failed,
 * timed out) the next queued item starts immediately. A failing item never stops the queue.
 */
export class WorkQueue<K> extends EventEmitter<{ change: [] }> {
  readonly items: QueueItem<K>[];
  private readonly pending: K[];
  private active = 0;
  private readonly ac = new AbortController();

  constructor(private readonly o: WorkQueueOptions<K>) {
    super();
    this.items = o.keys.map((key) => ({ key, state: 'queued', attempts: 0 }));
    this.pending = [...o.keys];
  }

  get concurrency(): number {
    return Math.max(1, Math.floor(this.o.concurrency));
  }

  cancel(): void {
    this.ac.abort();
  }

  counts(): QueueCounts {
    const c: QueueCounts = { running: 0, queued: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 };
    for (const i of this.items) c[i.state]++;
    return c;
  }

  run(): Promise<void> {
    return new Promise((resolve) => {
      const pump = () => {
        if (this.ac.signal.aborted) {
          for (const key of this.pending.splice(0)) Object.assign(this.item(key), { state: 'cancelled', message: 'скасовано' });
          this.emit('change');
          if (this.active === 0) resolve();
          return;
        }
        while (this.active < this.concurrency && this.pending.length) {
          const key = this.pending.shift()!;
          const item = this.item(key);
          this.active++;
          item.state = 'running';
          item.attempts++;
          item.startedAt = new Date().toISOString();
          this.emit('change');
          void this.runOne(key, item).finally(() => {
            this.active--;
            this.emit('change');
            pump();
          });
        }
        if (this.active === 0 && this.pending.length === 0) resolve();
      };
      pump();
    });
  }

  private item(key: K): QueueItem<K> {
    return this.items.find((i) => i.key === key)!;
  }

  private async runOne(key: K, item: QueueItem<K>): Promise<void> {
    const itemAc = new AbortController();
    const onAbort = () => itemAc.abort();
    this.ac.signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        if (this.o.itemTimeoutMs) {
          timer = setTimeout(() => {
            itemAc.abort();
            reject(new Error('таймаут'));
          }, this.o.itemTimeoutMs);
        }
      });
      const ctx: WorkerContext = {
        signal: itemAc.signal,
        attempt: item.attempts,
        setMessage: (msg) => {
          item.message = msg;
          this.emit('change');
        },
      };
      const r = await Promise.race([this.o.worker(key, ctx), timeout]);
      if (r.state === 'requeue') {
        if (item.attempts <= (this.o.maxRequeues ?? 1) && !this.ac.signal.aborted) {
          item.state = 'queued';
          this.pending.push(key);
        } else item.state = 'skipped';
        item.message = r.message;
      } else {
        item.state = r.state;
        if (r.message) item.message = r.message;
      }
    } catch (e) {
      item.state = this.ac.signal.aborted ? 'cancelled' : 'failed';
      item.message = this.ac.signal.aborted ? 'скасовано' : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
      this.ac.signal.removeEventListener('abort', onAbort);
      if (item.state !== 'queued') item.finishedAt = new Date().toISOString();
    }
  }
}
