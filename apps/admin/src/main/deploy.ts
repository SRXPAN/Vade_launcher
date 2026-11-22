/**
 * Broadcast command execution and verified LAN file deployment across selected club PCs.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DeployExecArgs, DeployExecResult, DeployFileArgs, DeployFileResult, LogLevel, PcRuntime } from '@vade/protocol';
import type { DeployItemStatus, DeployRunStatus } from '../shared/api';
import { sha256OfFile } from './agentUpdater';
import { WorkQueue, type WorkerResult } from './workQueue';

/** Serves one file over HTTP under a random token route while a file deploy runs. */
export class DeployFileServer {
  private server: http.Server | null = null;
  private token = '';
  private fileName = 'payload.bin';
  port = 0;

  constructor(private readonly bindHost = '0.0.0.0') {}

  async start(filePath: string, preferredPort = 7421): Promise<void> {
    await this.stop();
    this.token = randomBytes(12).toString('hex');
    this.fileName = encodeURIComponent(path.basename(filePath));
    const route = `/vade-deploy/${this.token}/${this.fileName}`;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== route) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const size = fs.statSync(filePath).size;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
      fs.createReadStream(filePath).pipe(res);
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.bindHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(preferredPort);
    } catch {
      await listen(0);
    }
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  url(host: string): string {
    const h = host.includes(':') ? `[${host}]` : host;
    return `http://${h}:${this.port}/vade-deploy/${this.token}/${this.fileName}`;
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
}

export interface DeployHost {
  runtime(id: number): PcRuntime;
  localAddressOf(id: number): string | null;
  deployExec(id: number, args: DeployExecArgs): Promise<DeployExecResult>;
  deployFile(id: number, args: DeployFileArgs): Promise<DeployFileResult>;
  log(id: number, level: LogLevel, msg: string): void;
}

export class DeployManager extends EventEmitter<{ status: [DeployRunStatus | null] }> {
  private queue: WorkQueue<number> | null = null;
  private meta: { kind: 'exec' | 'file'; title: string; startedAt: string; finishedAt?: string } | null = null;
  private execResults = new Map<number, DeployExecResult>();
  private fileResults = new Map<number, DeployFileResult>();
  private emitTimer: NodeJS.Timeout | null = null;
  readonly server = new DeployFileServer();

  constructor(private readonly host: DeployHost) {
    super();
  }

  isRunning(): boolean {
    return !!this.queue && !this.meta?.finishedAt;
  }

  async startExec(pcIds: number[], args: DeployExecArgs): Promise<void> {
    if (this.isRunning()) throw new Error('Розсилка вже виконується');
    const keys = [...new Set(pcIds)].sort((a, b) => a - b);
    this.execResults.clear();
    this.fileResults.clear();
    const preview = args.script.trim().split(/\r?\n/)[0].slice(0, 60);
    this.meta = { kind: 'exec', title: `${args.shell}: ${preview}`, startedAt: new Date().toISOString() };
    const q = new WorkQueue<number>({
      keys,
      concurrency: 6,
      worker: async (id, ctx): Promise<WorkerResult> => {
        if (this.host.runtime(id).link !== 'online') return { state: 'skipped', message: 'не в мережі' };
        ctx.setMessage('виконання…');
        this.host.log(id, 'info', `Deploy команди (${args.shell}): ${preview}`);
        const res = await this.host.deployExec(id, args);
        this.execResults.set(id, res);
        if (res.timedOut) throw new Error(`таймаут (${res.durationMs} мс)`);
        if (res.exitCode !== 0) {
          const detail = res.stderr.trim().split(/\r?\n/)[0] || res.stdout.trim().split(/\r?\n/)[0] || `код ${res.exitCode}`;
          throw new Error(`код ${res.exitCode}: ${detail}`);
        }
        return { state: 'done', message: `код 0 (${res.durationMs} мс)` };
      },
    });
    this.queue = q;
    q.on('change', () => this.emitSoon());
    void q.run().then(() => {
      if (this.meta) this.meta.finishedAt = new Date().toISOString();
      this.emitNow();
    });
    this.emitNow();
  }

  async startFile(pcIds: number[], localPath: string, targetPath: string): Promise<void> {
    if (this.isRunning()) throw new Error('Розсилка вже виконується');
    if (!fs.existsSync(localPath)) throw new Error('Локальний файл не знайдено');
    const sha256 = await sha256OfFile(localPath);
    await this.server.start(localPath, 7421);
    const keys = [...new Set(pcIds)].sort((a, b) => a - b);
    this.execResults.clear();
    this.fileResults.clear();
    this.meta = { kind: 'file', title: `${path.basename(localPath)} → ${targetPath}`, startedAt: new Date().toISOString() };

    const q = new WorkQueue<number>({
      keys,
      concurrency: 4,
      worker: async (id, ctx): Promise<WorkerResult> => {
        if (this.host.runtime(id).link !== 'online') return { state: 'skipped', message: 'не в мережі' };
        const addr = this.host.localAddressOf(id);
        if (!addr) throw new Error('невідома адреса адмін-ПК');
        ctx.setMessage('завантаження…');
        this.host.log(id, 'info', `Deploy файлу: ${path.basename(localPath)} → ${targetPath}`);
        const res = await this.host.deployFile(id, { url: this.server.url(addr), sha256, targetPath });
        this.fileResults.set(id, res);
        return { state: 'done', message: res.message };
      },
    });
    this.queue = q;
    q.on('change', () => this.emitSoon());
    void q.run().then(async () => {
      if (this.meta) this.meta.finishedAt = new Date().toISOString();
      await this.server.stop();
      this.emitNow();
    });
    this.emitNow();
  }

  cancel(): void {
    this.queue?.cancel();
  }

  stop(): void {
    this.queue?.cancel();
    void this.server.stop();
  }

  status(): DeployRunStatus | null {
    if (!this.queue || !this.meta) return null;
    const items: DeployItemStatus[] = this.queue.items.map((i) => ({
      pcId: i.key,
      state: i.state,
      message: i.message,
      ...(this.execResults.has(i.key) ? { exec: this.execResults.get(i.key) } : {}),
      ...(this.fileResults.has(i.key) ? { file: this.fileResults.get(i.key) } : {}),
    }));
    return {
      kind: this.meta.kind,
      title: this.meta.title,
      active: !this.meta.finishedAt,
      startedAt: this.meta.startedAt,
      finishedAt: this.meta.finishedAt,
      counts: this.queue.counts(),
      items,
    };
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('status', this.status());
    }, 150);
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.emit('status', this.status());
  }
}
