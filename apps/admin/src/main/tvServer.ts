import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import {
  publicPcStatus,
  qrToSvg,
  type PcRecord,
  type PcRuntime,
  type TvDisplayConfig,
} from '@vade/protocol';
import type { TvServerStatus } from '../shared/api';
import type { MapLayout } from '../shared/mapLayout';

export interface TvServerDeps {
  getConfig: () => TvDisplayConfig;
  getServedConfig: () => TvDisplayConfig;
  resolveAsset: (name: string) => { filePath: string; contentType: string } | null;
  getPcs: () => PcRecord[];
  getRuntime: (id: number) => PcRuntime | undefined;
  getMapLayout: () => MapLayout;
  getLocalIps: () => string[];
  /** Optional port override (e.g. 0 for ephemeral test port). */
  portOverride?: number;
}

export type TvPublicPcState = 'free' | 'busy' | 'maintenance' | 'offline';

export interface TvStatusResponse {
  updated: string;
  free: number;
  busy: number;
  maintenance: number;
  offline: number;
  total: number;
  pcs: Array<{
    id: number;
    name: string;
    zone: string;
    pos: { x: number; y: number } | null;
    state: TvPublicPcState;
  }>;
}

const SSE_PING_MS = 25_000;
const STATUS_DEBOUNCE_MS = 250;
const ASSET_PATH_PREFIX = '/tv-assets/';

/**
 * Local HTTP + SSE server serving the self-contained 16:9 esports club TV kiosk display
 * and live PC availability / layout / QR endpoints on the club LAN.
 */
export class TvServer extends EventEmitter<{ status: [TvServerStatus] }> {
  private server: http.Server | null = null;
  private running = false;
  private boundPort = 0;
  private lastError: string | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private pingTimer: NodeJS.Timeout | null = null;
  private statusDebounceTimer: NodeJS.Timeout | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();

  constructor(private readonly d: TvServerDeps) {
    super();
  }

  /** Starts the HTTP server if `localServerEnabled` is true; binds `0.0.0.0:<port>`. */
  start(): Promise<void> {
    return this.enqueueLifecycle(() => this.startInner());
  }

  /** Stops the HTTP server and closes all active SSE client connections. */
  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInner());
  }

  /** Applies config changes: stops/starts/restarts port if needed, or pushes `config` SSE event. */
  reconfigure(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const cfg = this.d.getConfig();
      const desiredPort = this.desiredPort(cfg);

      if (!cfg.localServerEnabled) {
        if (this.running || this.server || this.lastError) {
          this.lastError = null;
          await this.stopInner();
        } else {
          this.emitStatus();
        }
        return;
      }

      if (!this.running || (this.d.portOverride === undefined && this.boundPort !== desiredPort)) {
        await this.stopInner();
        await this.startInner();
        return;
      }

      this.broadcastSse('config', this.d.getServedConfig());
    });
  }

  /** Schedules a debounced (250 ms) SSE `status` broadcast to connected TV displays. */
  notifyStatus(): void {
    if (!this.running || this.sseClients.size === 0) return;
    if (this.statusDebounceTimer) clearTimeout(this.statusDebounceTimer);
    this.statusDebounceTimer = setTimeout(() => {
      this.statusDebounceTimer = null;
      this.broadcastSse('status', this.buildStatusPayload());
    }, STATUS_DEBOUNCE_MS);
  }

  /** Immediately pushes the updated club floor map layout to connected TV displays. */
  notifyLayout(): void {
    if (!this.running || this.sseClients.size === 0) return;
    this.broadcastSse('layout', this.d.getMapLayout());
  }

  /** Returns current server runtime status and reachable LAN URLs. */
  status(): TvServerStatus {
    const cfg = this.d.getConfig();
    const port = this.running && this.boundPort > 0 ? this.boundPort : this.desiredPort(cfg);
    const ips = this.running ? [...new Set(this.d.getLocalIps().map((x) => x.trim()).filter(Boolean))] : [];
    return {
      enabled: cfg.localServerEnabled,
      running: this.running,
      port,
      urls: this.running ? ips.map((ip) => `http://${ip}:${port}`) : [],
      clients: this.sseClients.size,
      error: this.lastError,
    };
  }

  private desiredPort(cfg: TvDisplayConfig): number {
    return this.d.portOverride !== undefined ? this.d.portOverride : cfg.localServerPort;
  }

  private enqueueLifecycle(fn: () => Promise<void>): Promise<void> {
    const next = this.lifecycleChain.then(fn, fn);
    this.lifecycleChain = next.catch(() => undefined);
    return next;
  }

  private async startInner(): Promise<void> {
    const cfg = this.d.getConfig();
    if (!cfg.localServerEnabled) {
      this.lastError = null;
      this.emitStatus();
      return;
    }

    const desiredPort = this.desiredPort(cfg);
    if (this.running && this.server && (this.d.portOverride !== undefined || this.boundPort === desiredPort)) {
      return;
    }

    await this.stopInner(false);

    const srv = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      srv.on('error', (err: NodeJS.ErrnoException) => {
        const msg = err.code === 'EADDRINUSE' ? `Порт ${desiredPort} вже зайнятий` : err.message;
        this.lastError = msg;
        this.running = false;
        this.boundPort = 0;
        if (this.server === srv) this.server = null;
        this.stopTimers();
        this.closeAllSse();
        try {
          srv.close();
        } catch {
          // ignore cleanup close error
        }
        this.emitStatus();
        settle();
      });

      srv.listen(desiredPort, '0.0.0.0', () => {
        const addr = srv.address();
        this.server = srv;
        this.running = true;
        this.boundPort = addr && typeof addr === 'object' ? addr.port : desiredPort;
        this.lastError = null;
        this.startPingTimer();
        this.emitStatus();
        settle();
      });
    });
  }

  private async stopInner(emitAfter = true): Promise<void> {
    this.stopTimers();
    this.closeAllSse();

    const srv = this.server;
    this.server = null;
    const wasRunning = this.running;
    this.running = false;
    this.boundPort = 0;

    if (srv) {
      await new Promise<void>((resolve) => {
        try {
          srv.closeAllConnections?.();
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    if (emitAfter && (wasRunning || srv)) {
      this.emitStatus();
    }
  }

  private startPingTimer(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      for (const res of this.sseClients) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.sseClients.delete(res);
        }
      }
    }, SSE_PING_MS);
    this.pingTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.statusDebounceTimer) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
  }

  private closeAllSse(): void {
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // ignore closed socket
      }
    }
    this.sseClients.clear();
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  private buildStatusPayload(): TvStatusResponse {
    const layout = this.d.getMapLayout();
    const posMap = new Map<number, { x: number; y: number }>();
    for (const slot of layout.pcs) {
      posMap.set(slot.id, { x: slot.x, y: slot.y });
    }

    let free = 0;
    let busy = 0;
    let maintenance = 0;
    let offline = 0;

    const pcs = [...this.d.getPcs()]
      .sort((a, b) => a.id - b.id)
      .map((pc) => {
        const pub = publicPcStatus(this.d.getRuntime(pc.id), pc);
        const state: TvPublicPcState = pub === 'occupied' ? 'busy' : pub;
        if (state === 'free') free++;
        else if (state === 'busy') busy++;
        else if (state === 'maintenance') maintenance++;
        else offline++;

        return {
          id: pc.id,
          name: pc.name ?? `PC-${pc.id}`,
          zone: pc.zone,
          pos: posMap.get(pc.id) ?? null,
          state,
        };
      });

    return {
      updated: new Date().toISOString(),
      free,
      busy,
      maintenance,
      offline,
      total: pcs.length,
      pcs,
    };
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const { pathname, searchParams } = url;

    if (pathname === '/' || pathname === '/tv' || pathname === '/tv.html') {
      const html = renderKioskHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }

    if (pathname === '/api/status') {
      this.sendJson(res, req.method, this.buildStatusPayload());
      return;
    }

    if (pathname === '/api/tv-config') {
      const inline = searchParams.get('inline') === '1';
      const payload = inline ? this.d.getConfig() : this.d.getServedConfig();
      this.sendJson(res, req.method, payload);
      return;
    }

    if (pathname === '/api/map-layout') {
      this.sendJson(res, req.method, this.d.getMapLayout());
      return;
    }

    if (pathname === '/api/qr') {
      const text = (searchParams.get('text') ?? '').trim();
      if (!text || text.length > 500) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid QR text');
        return;
      }
      try {
        const svg = qrToSvg(text, { fg: '#0b0e14', bg: '#ffffff', margin: 2 });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(req.method === 'HEAD' ? undefined : svg);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('QR payload too long');
      }
      return;
    }

    if (pathname === '/api/events') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end();
        return;
      }
      this.handleSse(req, res);
      return;
    }

    if (pathname.startsWith(ASSET_PATH_PREFIX)) {
      const rawName = pathname.slice(ASSET_PATH_PREFIX.length);
      let decoded = rawName;
      try {
        decoded = decodeURIComponent(rawName);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const asset = this.d.resolveAsset(decoded);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      try {
        const bytes = fs.readFileSync(asset.filePath);
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  private sendJson(res: http.ServerResponse, method: string, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    this.sseClients.add(res);
    this.emitStatus();

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      writeEvent('status', this.buildStatusPayload());
      writeEvent('config', this.d.getServedConfig());
      writeEvent('layout', this.d.getMapLayout());
    } catch {
      this.sseClients.delete(res);
      this.emitStatus();
      return;
    }

    const cleanup = () => {
      if (this.sseClients.delete(res)) {
        this.emitStatus();
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  private broadcastSse(event: string, data: unknown): void {
    if (this.sseClients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let dropped = false;
    for (const res of this.sseClients) {
      try {
        res.write(frame);
      } catch {
        this.sseClients.delete(res);
        dropped = true;
      }
    }
    if (dropped) this.emitStatus();
  }
}

function renderKioskHtml(): string {
  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VADE Cyber Club — TV Live Display</title>
  <style>
    :root {
      --bg: #07090e;
      --panel: #0d111a;
      --panel-2: #121826;
      --border: rgba(255, 255, 255, 0.08);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --mint: #2ef2c4;
      --magenta: #e040fb;
      --amber: #f59e0b;
      --slate: #475569;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
      overflow: hidden;
      user-select: none;
    }
    .kiosk {
      width: 100vw;
      height: 100vh;
      display: grid;
      grid-template-columns: 60% 40%;
      gap: 16px;
      padding: 16px;
      background:
        radial-gradient(circle at 12% 10%, rgba(46, 242, 196, 0.08), transparent 45%),
        radial-gradient(circle at 88% 85%, rgba(224, 64, 251, 0.09), transparent 45%),
        var(--bg);
    }
    .kiosk.no-right {
      grid-template-columns: 100%;
    }
    .kiosk.no-right .right-col {
      display: none;
    }
    .left-col, .right-col {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .card {
      background: linear-gradient(180deg, rgba(18, 24, 38, 0.92), rgba(11, 15, 24, 0.96));
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    }
    .header {
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-shrink: 0;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .brand-badge {
      padding: 6px 12px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 15px;
      letter-spacing: 0.14em;
      color: #07090e;
      background: linear-gradient(135deg, var(--mint), #00d2ff);
      box-shadow: 0 0 22px rgba(46, 242, 196, 0.35);
      flex-shrink: 0;
    }
    .title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .zones {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .zone-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 14px;
      font-weight: 600;
    }
    .zone-pill .count {
      color: var(--mint);
      font-weight: 800;
    }
    .clock-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .reconnect-badge {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(245, 158, 11, 0.16);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fbbf24;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .reconnect-badge.visible {
      display: inline-flex;
    }
    .clock {
      text-align: right;
      line-height: 1.1;
    }
    .clock-time {
      font-size: 26px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
    }
    .clock-date {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .map-card {
      flex: 1;
      min-height: 0;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }
    #mapSvg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .footer-legend {
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-shrink: 0;
      font-size: 14px;
    }
    .legend-items {
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      color: var(--text);
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 4px;
      display: inline-block;
    }
    .dot.free { background: var(--mint); box-shadow: 0 0 10px rgba(46, 242, 196, 0.6); }
    .dot.busy { background: var(--magenta); box-shadow: 0 0 10px rgba(224, 64, 251, 0.55); }
    .dot.maint { background: var(--amber); }
    .dot.offline { background: var(--slate); }
    .total-summary {
      color: var(--muted);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .carousel-card {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      flex-shrink: 0;
      background: #0a0e17;
    }
    .carousel-card.hidden {
      display: none;
    }
    .slide-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .slide-scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(180deg, rgba(7, 9, 14, 0.05) 35%, rgba(7, 9, 14, 0.9) 100%);
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 22px 24px 28px;
      gap: 6px;
    }
    .slide-scrim.hidden { display: none; }
    .slide-title {
      font-size: 26px;
      font-weight: 800;
      line-height: 1.15;
      text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);
    }
    .slide-subtitle {
      font-size: 15px;
      color: #dbeafe;
      line-height: 1.35;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
    }
    .slide-dots {
      position: absolute;
      right: 16px;
      bottom: 14px;
      display: flex;
      gap: 6px;
      z-index: 2;
    }
    .slide-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.3);
      transition: width 0.25s ease, background 0.25s ease;
    }
    .slide-dot.active {
      width: 22px;
      background: var(--mint);
    }
    .slide-progress-track {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4px;
      background: rgba(255, 255, 255, 0.12);
      z-index: 2;
    }
    .slide-progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--mint), var(--magenta));
    }
    .qr-grid {
      flex: 1;
      min-height: 0;
      display: grid;
      gap: 12px;
      align-content: center;
    }
    .qr-grid.hidden { display: none; }
    .qr-card {
      position: relative;
      aspect-ratio: 3 / 4;
      max-height: 100%;
      width: 100%;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 12px 10px;
      background-color: #161b26;
      background-size: cover;
      background-position: center;
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.4);
    }
    .qr-card-overlay {
      position: absolute;
      inset: 0;
      background: rgba(7, 9, 14, 0.45);
      pointer-events: none;
    }
    .qr-frame {
      position: relative;
      z-index: 1;
      width: 82%;
      aspect-ratio: 1 / 1;
      background: #ffffff;
      border-radius: 12px;
      padding: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    }
    .qr-frame img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .qr-labels {
      position: relative;
      z-index: 1;
      text-align: center;
      width: 100%;
    }
    .qr-label {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.02em;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qr-sublabel {
      font-size: 11px;
      color: rgba(241, 245, 249, 0.85);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }
  </style>
</head>
<body>
  <div id="kioskRoot" class="kiosk no-right">
    <div class="left-col">
      <div class="card header">
        <div class="brand-wrap">
          <div class="brand-badge">VADE CLUB</div>
          <div id="headerTitle" class="title">STANOWISKA</div>
        </div>
        <div id="zonePills" class="zones"></div>
        <div class="clock-wrap">
          <div id="reconnectBadge" class="reconnect-badge">OFFLINE</div>
          <div class="clock">
            <div id="clockTime" class="clock-time">--:--</div>
            <div id="clockDate" class="clock-date">---</div>
          </div>
        </div>
      </div>

      <div class="card map-card">
        <svg id="mapSvg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"></svg>
      </div>

      <div class="card footer-legend">
        <div id="legendItems" class="legend-items"></div>
        <div id="totalSummary" class="total-summary"></div>
      </div>
    </div>

    <div class="right-col">
      <div id="carouselCard" class="card carousel-card hidden">
        <img id="slideImg" class="slide-img" alt="" />
        <div id="slideScrim" class="slide-scrim hidden">
          <div id="slideTitle" class="slide-title"></div>
          <div id="slideSubtitle" class="slide-subtitle"></div>
        </div>
        <div id="slideDots" class="slide-dots"></div>
        <div class="slide-progress-track">
          <div id="slideProgressFill" class="slide-progress-fill"></div>
        </div>
      </div>
      <div id="qrGrid" class="qr-grid hidden"></div>
    </div>
  </div>

  <script>
    (function () {
      const I18N = {
        pl: {
          title: 'WOLNE STANOWISKA',
          free: 'Wolne',
          busy: 'Zajęte',
          maint: 'Serwis',
          offline: 'Wyłączone',
          total: 'Razem',
          reconnect: 'PONOWNE ŁĄCZENIE',
          locale: 'pl-PL',
        },
        ua: {
          title: 'ВІЛЬНІ МІСЦЯ',
          free: 'Вільні',
          busy: 'Зайняті',
          maint: 'Сервіс',
          offline: 'Вимкнені',
          total: 'Всього',
          reconnect: 'ПІДКЛЮЧЕННЯ',
          locale: 'uk-UA',
        },
        en: {
          title: 'LIVE STATIONS',
          free: 'Free',
          busy: 'Occupied',
          maint: 'Service',
          offline: 'Offline',
          total: 'Total',
          reconnect: 'RECONNECTING',
          locale: 'en-GB',
        },
      };

      const LANDMARK_GLYPHS = {
        entrance: 'IN',
        exit: 'EXIT',
        reception: 'ADM',
        wc: 'WC',
        bar: 'BAR',
        sofa: 'LOUNGE',
        console: 'PS5',
        server: 'SRV',
        extinguisher: 'FIRE',
      };

      const CELL = 44;
      const SVG_NS = 'http://www.w3.org/2000/svg';

      const state = {
        status: null,
        config: null,
        layout: null,
        slideIndex: 0,
        slideTimer: null,
        progressRaf: null,
      };

      const el = {
        root: document.getElementById('kioskRoot'),
        headerTitle: document.getElementById('headerTitle'),
        zonePills: document.getElementById('zonePills'),
        reconnectBadge: document.getElementById('reconnectBadge'),
        clockTime: document.getElementById('clockTime'),
        clockDate: document.getElementById('clockDate'),
        mapSvg: document.getElementById('mapSvg'),
        legendItems: document.getElementById('legendItems'),
        totalSummary: document.getElementById('totalSummary'),
        carouselCard: document.getElementById('carouselCard'),
        slideImg: document.getElementById('slideImg'),
        slideScrim: document.getElementById('slideScrim'),
        slideTitle: document.getElementById('slideTitle'),
        slideSubtitle: document.getElementById('slideSubtitle'),
        slideDots: document.getElementById('slideDots'),
        slideProgressFill: document.getElementById('slideProgressFill'),
        qrGrid: document.getElementById('qrGrid'),
      };

      function dict() {
        const lang = state.config && I18N[state.config.lang] ? state.config.lang : 'pl';
        return I18N[lang];
      }

      function safeHex(v, fallback) {
        return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
      }

      function safeImgSrc(v) {
        if (typeof v !== 'string') return '';
        const t = v.trim();
        if (t.startsWith('/tv-assets/') || t.startsWith('/api/qr?') || /^data:image\\//i.test(t)) return t;
        return '';
      }

      function updateClock() {
        const now = new Date();
        const d = dict();
        el.clockTime.textContent = now.toLocaleTimeString(d.locale, { hour: '2-digit', minute: '2-digit' });
        el.clockDate.textContent = now.toLocaleDateString(d.locale, { weekday: 'short', day: '2-digit', month: '2-digit' });
      }

      function renderHeaderAndLegend() {
        const d = dict();
        el.headerTitle.textContent = d.title;
        el.reconnectBadge.textContent = d.reconnect;

        const st = state.status;
        el.zonePills.replaceChildren();
        el.legendItems.replaceChildren();

        if (!st) return;

        const zoneStats = new Map();
        for (const pc of st.pcs || []) {
          const z = pc.zone || 'Regular';
          const cur = zoneStats.get(z) || { free: 0, total: 0 };
          cur.total++;
          if (pc.state === 'free') cur.free++;
          zoneStats.set(z, cur);
        }

        for (const [zone, stats] of zoneStats.entries()) {
          const pill = document.createElement('div');
          pill.className = 'zone-pill';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = zone;
          const cntSpan = document.createElement('span');
          cntSpan.className = 'count';
          cntSpan.textContent = stats.free + '/' + stats.total;
          pill.appendChild(nameSpan);
          pill.appendChild(cntSpan);
          el.zonePills.appendChild(pill);
        }

        const defs = [
          ['free', d.free, st.free],
          ['busy', d.busy, st.busy],
          ['maint', d.maint, st.maintenance],
          ['offline', d.offline, st.offline],
        ];
        for (const [cls, label, count] of defs) {
          const item = document.createElement('div');
          item.className = 'legend-item';
          const dot = document.createElement('span');
          dot.className = 'dot ' + cls;
          const txt = document.createElement('span');
          txt.textContent = label + ': ' + count;
          item.appendChild(dot);
          item.appendChild(txt);
          el.legendItems.appendChild(item);
        }

        el.totalSummary.textContent = d.total + ': ' + st.free + ' / ' + st.total;
      }

      function svgEl(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) {
          node.setAttribute(k, String(v));
        }
        return node;
      }

      function pcColors(pcState) {
        if (pcState === 'free') {
          return { fill: 'rgba(46, 242, 196, 0.18)', stroke: '#2ef2c4', text: '#2ef2c4' };
        }
        if (pcState === 'busy') {
          return { fill: 'rgba(224, 64, 251, 0.2)', stroke: '#e040fb', text: '#f5d0fe' };
        }
        if (pcState === 'maintenance') {
          return { fill: 'rgba(245, 158, 11, 0.2)', stroke: '#f59e0b', text: '#fde68a' };
        }
        if (pcState === 'offline') {
          return { fill: 'rgba(71, 85, 105, 0.28)', stroke: '#475569', text: '#94a3b8' };
        }
        return { fill: 'rgba(30, 41, 59, 0.2)', stroke: '#334155', text: '#64748b' };
      }

      function renderMap() {
        const layout = state.layout;
        const svg = el.mapSvg;
        svg.replaceChildren();
        if (!layout) return;

        const cols = Number(layout.cols) || 24;
        const rows = Number(layout.rows) || 14;
        const pad = 12;
        svg.setAttribute('viewBox', -pad + ' ' + -pad + ' ' + (cols * CELL + pad * 2) + ' ' + (rows * CELL + pad * 2));

        // Zone boxes
        for (const z of layout.zones || []) {
          const color = safeHex(z.color, '#4f8cff');
          svg.appendChild(
            svgEl('rect', {
              x: z.x * CELL + 2,
              y: z.y * CELL + 2,
              width: z.w * CELL - 4,
              height: z.h * CELL - 4,
              rx: 10,
              fill: color,
              'fill-opacity': 0.1,
              stroke: color,
              'stroke-opacity': 0.45,
              'stroke-width': 1.5,
            }),
          );
        }

        // Walls
        for (const w of layout.walls || []) {
          svg.appendChild(
            svgEl('line', {
              x1: w.x1 * CELL,
              y1: w.y1 * CELL,
              x2: w.x2 * CELL,
              y2: w.y2 * CELL,
              stroke: '#38465d',
              'stroke-width': 3.5,
              'stroke-linecap': 'round',
            }),
          );
        }

        // Landmarks
        for (const m of layout.landmarks || []) {
          const cx = m.x * CELL;
          const cy = m.y * CELL;
          const g = svgEl('g', { transform: 'translate(' + cx + ',' + cy + ') rotate(' + (m.rot || 0) + ')' });
          g.appendChild(
            svgEl('rect', {
              x: -16,
              y: -11,
              width: 32,
              height: 22,
              rx: 6,
              fill: 'rgba(148, 163, 184, 0.14)',
              stroke: 'rgba(148, 163, 184, 0.35)',
              'stroke-width': 1,
            }),
          );
          const t = svgEl('text', {
            x: 0,
            y: 3.5,
            'text-anchor': 'middle',
            fill: '#94a3b8',
            'font-size': 9,
            'font-weight': 700,
          });
          t.textContent = LANDMARK_GLYPHS[m.kind] || '•';
          g.appendChild(t);
          svg.appendChild(g);
        }

        // Labels
        for (const lbl of layout.labels || []) {
          const t = svgEl('text', {
            x: lbl.x * CELL,
            y: lbl.y * CELL + 4,
            'text-anchor': 'middle',
            fill: lbl.zone === 'Stream' ? '#e040fb' : '#94a3b8',
            'font-size': 12,
            'font-weight': 700,
            'letter-spacing': '0.06em',
          });
          t.textContent = lbl.text || '';
          svg.appendChild(t);
        }

        // PCs
        const pcStateMap = new Map();
        if (state.status && Array.isArray(state.status.pcs)) {
          for (const pc of state.status.pcs) pcStateMap.set(pc.id, pc.state);
        }

        for (const slot of layout.pcs || []) {
          const st = pcStateMap.get(slot.id) || 'unmapped';
          const c = pcColors(st);
          const x = slot.x * CELL + 4;
          const y = slot.y * CELL + 4;
          const size = CELL - 8;

          const rectAttrs = {
            x,
            y,
            width: size,
            height: size,
            rx: 8,
            fill: c.fill,
            stroke: c.stroke,
            'stroke-width': st === 'free' ? 2.2 : 1.8,
          };
          if (st === 'unmapped') rectAttrs['stroke-dasharray'] = '3 3';
          svg.appendChild(svgEl('rect', rectAttrs));

          const numText = svgEl('text', {
            x: slot.x * CELL + CELL / 2,
            y: slot.y * CELL + CELL / 2 + 5,
            'text-anchor': 'middle',
            fill: c.text,
            'font-size': 13,
            'font-weight': 800,
          });
          numText.textContent = String(slot.id);
          svg.appendChild(numText);
        }
      }

      function stopSlideTimers() {
        if (state.slideTimer) {
          clearTimeout(state.slideTimer);
          state.slideTimer = null;
        }
        if (state.progressRaf) {
          cancelAnimationFrame(state.progressRaf);
          state.progressRaf = null;
        }
      }

      function renderRightPanel() {
        stopSlideTimers();
        const cfg = state.config;
        const slides = cfg && Array.isArray(cfg.slides) ? cfg.slides.filter((s) => s.enabled !== false && (safeImgSrc(s.imageDataUrl) || s.mode === 'with_text')) : [];
        const cards = cfg && Array.isArray(cfg.qrCards) ? cfg.qrCards.filter((c) => c.enabled !== false).slice(0, 4) : [];

        if (slides.length === 0 && cards.length === 0) {
          el.root.classList.add('no-right');
          el.carouselCard.classList.add('hidden');
          el.qrGrid.classList.add('hidden');
          return;
        }

        el.root.classList.remove('no-right');

        if (slides.length === 0) {
          el.carouselCard.classList.add('hidden');
        } else {
          el.carouselCard.classList.remove('hidden');
          if (state.slideIndex >= slides.length) state.slideIndex = 0;

          const showSlide = () => {
            stopSlideTimers();
            const slide = slides[state.slideIndex % slides.length];
            const imgSrc = safeImgSrc(slide.imageDataUrl);
            if (imgSrc) {
              el.slideImg.src = imgSrc;
              el.slideImg.style.display = 'block';
            } else {
              el.slideImg.removeAttribute('src');
              el.slideImg.style.display = 'none';
            }

            if (slide.mode === 'with_text' && (slide.title || slide.subtitle)) {
              el.slideScrim.classList.remove('hidden');
              el.slideTitle.textContent = slide.title || '';
              el.slideSubtitle.textContent = slide.subtitle || '';
            } else {
              el.slideScrim.classList.add('hidden');
              el.slideTitle.textContent = '';
              el.slideSubtitle.textContent = '';
            }

            el.slideDots.replaceChildren();
            if (slides.length > 1) {
              for (let i = 0; i < slides.length; i++) {
                const dot = document.createElement('div');
                dot.className = 'slide-dot' + (i === state.slideIndex ? ' active' : '');
                el.slideDots.appendChild(dot);
              }
            }

            const defaultSec = (cfg && cfg.defaultSlideDurationSec) || 8;
            const sec = Math.max(5, Number(slide.durationSec || defaultSec) || 8);
            const durMs = sec * 1000;
            const started = performance.now();

            const tickProgress = (now) => {
              const pct = Math.min(100, ((now - started) / durMs) * 100);
              el.slideProgressFill.style.width = pct.toFixed(1) + '%';
              if (pct < 100) {
                state.progressRaf = requestAnimationFrame(tickProgress);
              }
            };
            state.progressRaf = requestAnimationFrame(tickProgress);

            if (slides.length > 1) {
              state.slideTimer = setTimeout(() => {
                state.slideIndex = (state.slideIndex + 1) % slides.length;
                showSlide();
              }, durMs);
            }
          };

          showSlide();
        }

        el.qrGrid.replaceChildren();
        if (cards.length === 0) {
          el.qrGrid.classList.add('hidden');
        } else {
          el.qrGrid.classList.remove('hidden');
          el.qrGrid.style.gridTemplateColumns = 'repeat(' + cards.length + ', minmax(0, 1fr))';
          for (const c of cards) {
            const card = document.createElement('div');
            card.className = 'qr-card';
            const bgSrc = c.bgType === 'image' ? safeImgSrc(c.bgImageDataUrl) : '';
            if (bgSrc) {
              card.style.backgroundImage = 'url("' + bgSrc.replace(/"/g, '%22') + '")';
              const ov = document.createElement('div');
              ov.className = 'qr-card-overlay';
              card.appendChild(ov);
            } else {
              card.style.backgroundColor = safeHex(c.bgColor, '#161b26');
            }

            const frame = document.createElement('div');
            frame.className = 'qr-frame';
            let qrSrc = '';
            if (c.qrSource === 'generate' && c.qrText) {
              qrSrc = '/api/qr?text=' + encodeURIComponent(c.qrText);
            } else if (c.qrSource === 'upload' && c.qrImageDataUrl) {
              qrSrc = safeImgSrc(c.qrImageDataUrl);
            }
            if (qrSrc) {
              const img = document.createElement('img');
              img.src = qrSrc;
              img.alt = c.label || 'QR';
              frame.appendChild(img);
            }
            card.appendChild(frame);

            const labels = document.createElement('div');
            labels.className = 'qr-labels';
            const lbl = document.createElement('div');
            lbl.className = 'qr-label';
            lbl.textContent = c.label || '';
            labels.appendChild(lbl);
            if (c.sublabel) {
              const sub = document.createElement('div');
              sub.className = 'qr-sublabel';
              sub.textContent = c.sublabel;
              labels.appendChild(sub);
            }
            card.appendChild(labels);
            el.qrGrid.appendChild(card);
          }
        }
      }

      async function fetchAll() {
        try {
          const [stRes, cfgRes, mapRes] = await Promise.all([
            fetch('/api/status', { cache: 'no-store' }),
            fetch('/api/tv-config', { cache: 'no-store' }),
            fetch('/api/map-layout', { cache: 'no-store' }),
          ]);
          if (stRes.ok) state.status = await stRes.json();
          if (cfgRes.ok) state.config = await cfgRes.json();
          if (mapRes.ok) state.layout = await mapRes.json();
          el.reconnectBadge.classList.remove('visible');
          updateClock();
          renderHeaderAndLegend();
          renderMap();
          renderRightPanel();
        } catch {
          el.reconnectBadge.classList.add('visible');
        }
      }

      function connectSse() {
        if (typeof EventSource === 'undefined') return;
        const es = new EventSource('/api/events');
        es.onopen = () => el.reconnectBadge.classList.remove('visible');
        es.onerror = () => el.reconnectBadge.classList.add('visible');
        es.addEventListener('status', (ev) => {
          try {
            state.status = JSON.parse(ev.data);
            el.reconnectBadge.classList.remove('visible');
            renderHeaderAndLegend();
            renderMap();
          } catch {}
        });
        es.addEventListener('config', (ev) => {
          try {
            state.config = JSON.parse(ev.data);
            el.reconnectBadge.classList.remove('visible');
            updateClock();
            renderHeaderAndLegend();
            renderRightPanel();
          } catch {}
        });
        es.addEventListener('layout', (ev) => {
          try {
            state.layout = JSON.parse(ev.data);
            el.reconnectBadge.classList.remove('visible');
            renderMap();
          } catch {}
        });
      }

      async function requestWakeLock() {
        try {
          if (navigator.wakeLock && document.visibilityState === 'visible') {
            await navigator.wakeLock.request('screen');
          }
        } catch {}
      }

      function scheduleDailyReload() {
        const now = new Date();
        const next = new Date(now);
        next.setHours(6, 0, 0, 0);
        if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
        setTimeout(() => location.reload(), next.getTime() - now.getTime());
      }

      updateClock();
      setInterval(updateClock, 1000);
      void fetchAll();
      connectSse();
      setInterval(() => {
        void fetch('/api/status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((st) => {
            if (!st) return;
            state.status = st;
            el.reconnectBadge.classList.remove('visible');
            renderHeaderAndLegend();
            renderMap();
          })
          .catch(() => el.reconnectBadge.classList.add('visible'));
      }, 15000);

      void requestWakeLock();
      document.addEventListener('visibilitychange', () => void requestWakeLock());
      scheduleDailyReload();
    })();
  </script>
</body>
</html>`;
}
