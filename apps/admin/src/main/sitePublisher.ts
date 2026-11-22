import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import {
  buildSitePayload,
  sitePayloadSignature,
  type PcRecord,
  type PcRuntime,
  type SitePayload,
  type SiteSettings,
} from '@vade/protocol';
import type { SiteAttempt, SiteEvent, SiteStatus, SiteTestResult } from '../shared/api';

export interface PublisherDeps {
  getSettings(): SiteSettings;
  getPcs(): PcRecord[];
  getRuntime(id: number): PcRuntime | undefined;
  /** Persists the per-day request counter across restarts */
  stateFile: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** Wait after start so agents can connect before the first payload (default 15 s) */
  startupDelayMs?: number;
  /** Lower bound of the heartbeat interval (default 15 s; tests use less) */
  minHeartbeatSec?: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const HISTORY = 20;
const MIN_RETRY_SEC = 30;

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Sends the public PC map to the club website:
 *  - when the public status of any PC changes (changes within `debounceSec` are merged into one request),
 *  - and as a heartbeat when nothing was sent for `heartbeatSec`.
 * Only successful requests count toward `dailyLimit` (UTC day), so the site stays within
 * Cloudflare KV Free (1000 writes/day). Test requests are not counted.
 */
export class SitePublisher extends EventEmitter<{ status: [SiteStatus] }> {
  private lastSentSig: string | null = null;
  private lastOkAt: string | null = null;
  private lastAttempt: SiteAttempt | null = null;
  private history: SiteAttempt[] = [];
  private counter: { day: string; count: number };
  private debounceTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retrySec = 0;
  private inFlight: Promise<void> | null = null;
  private again: SiteEvent | null = null;
  private started = false;
  /** false during the startup delay: agents are still connecting, everything would look offline */
  private ready = false;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: PublisherDeps) {
    super();
    this.counter = { day: utcDay(), count: 0 };
    try {
      const c = JSON.parse(fs.readFileSync(d.stateFile, 'utf8')) as { day?: string; count?: number };
      if (c.day === utcDay() && typeof c.count === 'number') this.counter = { day: c.day, count: c.count };
    } catch {
      // first run
    }
  }

  start(): void {
    this.started = true;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.ready = true;
      this.reconfigure();
    }, this.d.startupDelayMs ?? 15_000);
  }

  stop(): void {
    this.started = false;
    this.ready = false;
    for (const t of [this.startTimer, this.debounceTimer, this.heartbeatTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.startTimer = this.debounceTimer = this.heartbeatTimer = this.retryTimer = null;
  }

  /** After the site settings changed (or on start): forget what was sent and publish the current state. */
  reconfigure(): void {
    if (!this.started || !this.ready) return;
    this.lastSentSig = null;
    this.retrySec = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.scheduleHeartbeat();
    this.notifyChange();
    this.emitStatus();
  }

  /** Call on every runtime / PC list change; it is cheap when nothing public changed. */
  notifyChange(): void {
    const s = this.d.getSettings();
    if (!this.ready || !s.enabled || !s.url) return;
    if (this.debounceTimer) return;
    if (sitePayloadSignature(this.payload()) === this.lastSentSig) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush('change');
    }, Math.max(0, s.debounceSec) * 1000);
  }

  status(): SiteStatus {
    this.rollDay();
    const s = this.d.getSettings();
    return {
      enabled: s.enabled,
      day: this.counter.day,
      sentToday: this.counter.count,
      dailyLimit: s.dailyLimit,
      limitReached: this.limitReached(),
      lastAttempt: this.lastAttempt,
      lastOkAt: this.lastOkAt,
      history: this.history,
    };
  }

  payload(now = new Date()): SitePayload {
    return buildSitePayload(this.d.getPcs(), (id) => this.d.getRuntime(id), now);
  }

  /** "Тест підключення": real payload, event header "test", not counted, does not touch the schedule. */
  async test(url: string, token: string): Promise<SiteTestResult> {
    const r = await this.post(url, token, this.payload(), 'test');
    this.record({ at: new Date().toISOString(), event: 'test', ok: r.ok, status: r.status, error: r.error, ms: r.ms });
    return r;
  }

  /* ---------------------------------------------------------------- */

  private async flush(event: SiteEvent): Promise<void> {
    if (this.inFlight) {
      this.again = this.again === 'change' || event === 'change' ? 'change' : 'heartbeat';
      return;
    }
    const s = this.d.getSettings();
    if (!s.enabled || !s.url) return;
    const payload = this.payload();
    const sig = sitePayloadSignature(payload);
    if (event === 'change' && sig === this.lastSentSig) return;
    if (this.limitReached()) {
      this.emitStatus();
      return;
    }
    this.inFlight = (async () => {
      const r = await this.post(s.url, s.token, payload, event);
      // Counters first: record() pushes the status to the UI.
      if (r.ok) {
        this.lastSentSig = sig;
        this.lastOkAt = new Date().toISOString();
        this.retrySec = 0;
        this.rollDay();
        this.counter.count++;
        this.saveCounter();
        this.scheduleHeartbeat();
      } else {
        this.retrySec = Math.min(Math.max(MIN_RETRY_SEC, this.retrySec * 2), Math.max(MIN_RETRY_SEC, s.heartbeatSec));
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.flush('heartbeat');
        }, this.retrySec * 1000);
      }
      this.record({ at: new Date().toISOString(), event, ok: r.ok, status: r.status, error: r.error, ms: r.ms });
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      const next = this.again;
      this.again = null;
      if (next) void this.flush(next);
    }
  }

  private async post(url: string, token: string, payload: SitePayload, event: SiteEvent): Promise<SiteTestResult> {
    const started = Date.now();
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL має починатися з https://');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': this.d.userAgent,
        'X-Vade-Event': event,
        // lets the receiver tell "nothing changed" from "the admin PC is gone" (all PCs come in one request)
        'X-Vade-Heartbeat': String(this.d.getSettings().heartbeatSec),
      };
      if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
      const res = await (this.d.fetchImpl ?? fetch)(u, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined); // drain the body
      return { ok: res.ok, status: res.status, statusText: res.statusText, ms: Date.now() - started, ...(res.ok ? {} : { error: `HTTP ${res.status} ${res.statusText}`.trim() }) };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const msg = err.name === 'TimeoutError' ? 'сайт не відповів за 10 с' : (err.cause?.code ?? err.message);
      return { ok: false, error: msg, ms: Date.now() - started };
    }
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const s = this.d.getSettings();
    if (!this.ready || !s.enabled || !s.url) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.flush('heartbeat').finally(() => {
        if (!this.heartbeatTimer) this.scheduleHeartbeat();
      });
    }, Math.max(this.d.minHeartbeatSec ?? 15, s.heartbeatSec) * 1000);
  }

  private limitReached(): boolean {
    this.rollDay();
    const limit = this.d.getSettings().dailyLimit;
    return limit > 0 && this.counter.count >= limit;
  }

  private rollDay(): void {
    const day = utcDay();
    if (this.counter.day !== day) this.counter = { day, count: 0 };
  }

  private saveCounter(): void {
    try {
      fs.writeFileSync(this.d.stateFile, JSON.stringify(this.counter));
    } catch {
      // the counter is advisory
    }
  }

  private record(a: SiteAttempt): void {
    this.lastAttempt = a;
    this.history = [a, ...this.history].slice(0, HISTORY);
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }
}
