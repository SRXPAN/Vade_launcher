/**
 * OTA update of the agents over the club LAN.
 * A small HTTP server on the admin PC (port 7421, or a free one) serves the new VadeAgent.exe only
 * while a rollout runs; the agents get url + sha256 over their authenticated connection, download,
 * verify the hash and restart themselves. At most `concurrency` PCs download at once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { LogLevel, PcRuntime } from '@vade/protocol';
import type { AgentSource, AgentUpdateStatus } from '../shared/api';
import { WorkQueue, type WorkerContext, type WorkerResult } from './workQueue';

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The agent shipped with the admin app (agent-version.json is written by the agent build). */
export async function readBundledSource(packageDir: string): Promise<AgentSource | null> {
  const exe = path.join(packageDir, 'VadeAgent.exe');
  if (!fs.existsSync(exe)) return null;
  const size = fs.statSync(exe).size;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(packageDir, 'agent-version.json'), 'utf8')) as { version: string; sha256: string; size: number };
    if (meta.size === size && /^[0-9a-f]{64}$/.test(meta.sha256)) return { path: exe, version: meta.version, sha256: meta.sha256, size, bundled: true };
  } catch {
    // no metadata: compute below
  }
  return { path: exe, version: await exeVersion(exe), sha256: await sha256OfFile(exe), size, bundled: true };
}

/** `VadeAgent.exe version` prints the version. */
export function exeVersion(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, ['version'], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      const v = String(stdout ?? '').trim();
      if (!err && /^\d+\.\d+/.test(v)) resolve(v);
      else reject(new Error('не вдалося визначити версію — це точно VadeAgent.exe?'));
    });
  });
}

/** A VadeAgent.exe chosen by the admin. */
export async function fileSource(file: string): Promise<AgentSource> {
  const size = fs.statSync(file).size;
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ') throw new Error('Це не .exe файл');
  return { path: file, version: await exeVersion(file), sha256: await sha256OfFile(file), size, bundled: false };
}

/** Serves exactly one file under a random path, only while started. */
export class UpdateServer {
  private server: http.Server | null = null;
  private token = '';
  port = 0;

  /** bindHost 0.0.0.0: reachable from the club LAN (tests use 127.0.0.1) */
  constructor(private readonly bindHost = '0.0.0.0') {}

  async start(file: string, preferredPort = 7421): Promise<void> {
    await this.stop();
    this.token = randomBytes(12).toString('hex');
    const route = `/vade-agent/${this.token}/VadeAgent.exe`;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== route) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const size = fs.statSync(file).size;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
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
      await listen(0); // 7421 busy: any free port
    }
    this.server = server;
    this.port = (server.address() as { port: number }).port;
  }

  url(host: string): string {
    const h = host.includes(':') ? `[${host}]` : host;
    return `http://${h}:${this.port}/vade-agent/${this.token}/VadeAgent.exe`;
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
}

export interface UpdaterHost {
  runtime(id: number): PcRuntime;
  localAddressOf(id: number): string | null;
  selfUpdate(id: number, args: { url: string; sha256: string; version: string }): Promise<{ message: string }>;
  waitFor(id: number, pred: (rt: PcRuntime) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  log(id: number, level: LogLevel, msg: string): void;
}

export interface UpdaterTimeouts {
  /** The service must go down after the agent accepted the update */
  restartStartMs: number;
  /** …and come back with the new version (spec: 3 min) */
  comeBackMs: number;
}

export class AgentUpdater extends EventEmitter<{ status: [AgentUpdateStatus | null] }> {
  private queue: WorkQueue<number> | null = null;
  private meta: { version: string; startedAt: string; finishedAt?: string } | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  readonly server: UpdateServer;
  private readonly t: UpdaterTimeouts;

  constructor(
    private readonly host: UpdaterHost,
    timeouts: Partial<UpdaterTimeouts> = {},
    private readonly concurrency = 4,
    private readonly preferredPort = 7421,
    bindHost = '0.0.0.0',
  ) {
    super();
    this.t = { restartStartMs: 60_000, comeBackMs: 3 * 60_000, ...timeouts };
    this.server = new UpdateServer(bindHost);
  }

  isRunning(): boolean {
    return !!this.queue && !this.meta?.finishedAt;
  }

  async start(pcIds: number[], source: AgentSource, includeSameVersion: boolean): Promise<void> {
    if (this.isRunning()) throw new Error('Оновлення агентів уже триває');
    await this.server.start(source.path, this.preferredPort);
    this.meta = { version: source.version, startedAt: new Date().toISOString() };
    const q = new WorkQueue<number>({
      keys: [...pcIds].sort((a, b) => a - b),
      concurrency: this.concurrency,
      worker: (id, ctx) => this.work(id, source, includeSameVersion, ctx),
    });
    this.queue = q;
    q.on('change', () => this.emitSoon());
    void q.run().then(async () => {
      if (this.meta) this.meta.finishedAt = new Date().toISOString();
      await this.server.stop();
      this.emitSoon();
    });
    this.emitSoon();
  }

  cancel(): void {
    this.queue?.cancel();
  }

  status(): AgentUpdateStatus | null {
    if (!this.queue || !this.meta) return null;
    return {
      version: this.meta.version,
      startedAt: this.meta.startedAt,
      finishedAt: this.meta.finishedAt,
      active: !this.meta.finishedAt,
      port: this.server.port,
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

  private async work(id: number, src: AgentSource, includeSame: boolean, ctx: WorkerContext): Promise<WorkerResult> {
    const { host } = this;
    const rt = host.runtime(id);
    if (rt.link !== 'online') return { state: 'skipped', message: 'не в мережі' };
    const from = rt.info?.version ?? '?';
    if (!includeSame && from === src.version) return { state: 'skipped', message: `вже ${src.version}` };
    const addr = host.localAddressOf(id);
    if (!addr) throw new Error('невідома адреса адмін-ПК для цього агента');

    ctx.setMessage('завантаження і перевірка sha256…');
    host.log(id, 'info', `Оновлення агента ${from} → ${src.version}`);
    await host.selfUpdate(id, { url: this.server.url(addr), sha256: src.sha256, version: src.version });

    ctx.setMessage('перезапуск служби…');
    const wentDown = await host.waitFor(id, (r) => r.link !== 'online', this.t.restartStartMs, ctx.signal);
    if (!wentDown) throw new Error(ctx.signal.aborted ? 'скасовано' : 'служба не перезапустилась');
    const back = await host.waitFor(id, (r) => r.link === 'online' && r.info?.version === src.version, this.t.comeBackMs, ctx.signal);
    if (back) {
      host.log(id, 'info', `Агент оновлено до ${src.version}`);
      return { state: 'done', message: `${from} → ${src.version}` };
    }
    if (ctx.signal.aborted) throw new Error('скасовано');
    const now = host.runtime(id);
    if (now.link === 'online') throw new Error(`відкат: працює ${now.info?.version ?? '?'} (нова версія не стартувала)`);
    throw new Error(`не повернувся на зв'язок за ${Math.round(this.t.comeBackMs / 60_000)} хв`);
  }
}
