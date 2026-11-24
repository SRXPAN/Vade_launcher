import { EventEmitter } from 'node:events';
import { deriveTvConfigUrl, type SiteSettings, type TvDisplayConfig } from '@vade/protocol';
import type { TvPublishResult, TvPublishStatus } from '../shared/api';

export interface TvPublisherDeps {
  getSiteSettings: () => SiteSettings;
  getHydratedConfig: () => TvDisplayConfig;
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Publishes the hydrated TV kiosk configuration (slides, QR cards, language, timings)
 * to the club website's `/api/tv-config` endpoint using the configured Site Bearer token.
 */
export class TvPublisher extends EventEmitter<{ status: [TvPublishStatus] }> {
  private lastPublishAt: string | null = null;
  private lastResult: TvPublishResult | null = null;

  constructor(private readonly d: TvPublisherDeps) {
    super();
  }

  status(): TvPublishStatus {
    return {
      lastPublishAt: this.lastPublishAt,
      lastResult: this.lastResult,
    };
  }

  async publish(): Promise<TvPublishResult> {
    const started = Date.now();
    const site = this.d.getSiteSettings();
    const url = deriveTvConfigUrl(site.url);

    if (!url) {
      return this.finish({
        ok: false,
        error: 'URL сайту не вказано або некоректний',
        ms: Date.now() - started,
      });
    }

    const cfg = this.d.getHydratedConfig();
    const body = JSON.stringify(cfg);
    const bytes = Buffer.byteLength(body, 'utf8');
    const timeoutMs = this.d.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': this.d.userAgent,
      };
      const token = site.token.trim();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await (this.d.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);

      return this.finish({
        ok: res.ok,
        url,
        status: res.status,
        ms: Date.now() - started,
        bytes,
        ...(res.ok ? {} : { error: `HTTP ${res.status} ${res.statusText}`.trim() }),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const msg = err.name === 'TimeoutError' ? 'сайт не відповів за 20 с' : (err.cause?.code ?? err.message);
      return this.finish({
        ok: false,
        url,
        error: msg,
        ms: Date.now() - started,
        bytes,
      });
    }
  }

  private finish(result: TvPublishResult): TvPublishResult {
    this.lastResult = result;
    if (result.ok) {
      this.lastPublishAt = new Date().toISOString();
    }
    this.emit('status', this.status());
    return result;
  }
}
