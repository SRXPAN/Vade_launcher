import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_NOT_ALLOWED,
  CLOSE_NOT_CONFIGURED,
  CLOSE_PROTOCOL,
  PROTOCOL_VERSION,
  type AgentToAdmin,
  type CommandName,
  type EventName,
  type Events,
  type MsgAuth,
  type MsgRequest,
  type PowerAction,
} from '@vade/protocol';
import { agentProof, authMac, newNonce, safeEqual, sessionKey, unseal } from '@vade/protocol/auth';
import type { Agent } from './agent';
import { AgentError, errMsg } from './util';

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15_000;
const POWER_ACTIONS: PowerAction[] = ['sleep', 'hibernate', 'shutdown', 'restart'];

export interface ServerOptions {
  port: number;
  bind: string;
  clubKey: string;
  allowFrom: string[];
}

interface Client {
  ws: WebSocket;
  ip: string;
  authed: boolean;
  alive: boolean;
  sessKey: Buffer | null;
}

function cleanIp(addr: string | undefined): string {
  return (addr ?? '').replace(/^::ffff:/, '');
}

/** WebSocket server the admin app connects to. Every command requires the club key handshake. */
export class AgentServer {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly agent: Agent,
    private readonly opts: ServerOptions,
  ) {
    agent.on('status', (s) => this.broadcast('status', s));
    agent.on('log', (l) => this.broadcast('log', l));
    agent.on('power.pending', (p) => this.broadcast('power.pending', p));
  }

  get port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port, host: this.opts.bind, maxPayload: 1024 * 1024 });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (e) => this.agent.log.error(`WebSocket: ${e.message}`));
        resolve();
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.wss = wss;
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          c.ws.ping();
        }
      }, HEARTBEAT_MS);
    });
  }

  close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.terminate();
    return new Promise((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private send(ws: WebSocket, msg: AgentToAdmin): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast<E extends EventName>(ev: E, data: Events[E]): void {
    const frame = JSON.stringify({ t: 'evt', ev, data });
    for (const c of this.clients) if (c.authed && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = cleanIp(req.socket.remoteAddress);
    const { allowFrom, clubKey } = this.opts;
    if (allowFrom.length > 0 && ip !== '127.0.0.1' && !allowFrom.includes(ip)) {
      this.agent.log.warn(`Відхилено з'єднання з ${ip}: не в allowFrom`);
      ws.close(CLOSE_NOT_ALLOWED, 'not allowed');
      return;
    }
    const client: Client = { ws, ip, authed: false, alive: true, sessKey: null };
    this.clients.add(client);
    const nonce = newNonce();
    const authTimer = setTimeout(() => ws.close(CLOSE_AUTH_TIMEOUT, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(client);
    });
    ws.on('error', () => undefined);
    ws.on('message', (raw) => {
      let msg: MsgAuth | MsgRequest;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(CLOSE_PROTOCOL, 'bad json');
        return;
      }
      if (!client.authed) {
        clearTimeout(authTimer);
        if (msg.t !== 'auth' || typeof msg.nonce !== 'string' || typeof msg.mac !== 'string') {
          ws.close(CLOSE_PROTOCOL, 'auth expected');
          return;
        }
        if (!clubKey) {
          ws.close(CLOSE_NOT_CONFIGURED, 'agent has no club key');
          return;
        }
        if (!safeEqual(msg.mac, authMac(clubKey, nonce, msg.nonce))) {
          this.agent.log.warn(`Невдала автентифікація з ${ip} (невірний ключ клубу)`);
          ws.close(CLOSE_AUTH_FAILED, 'auth failed');
          return;
        }
        client.authed = true;
        client.sessKey = sessionKey(clubKey, nonce, msg.nonce);
        this.send(ws, { t: 'hello', proof: agentProof(clubKey, nonce, msg.nonce), info: this.agent.info(), status: this.agent.status() });
        return;
      }
      if (msg.t !== 'req' || typeof msg.id !== 'string' || typeof msg.cmd !== 'string') return;
      void this.dispatch(client, msg);
    });

    this.send(ws, { t: 'challenge', nonce, protocol: PROTOCOL_VERSION });
  }

  private async dispatch(client: Client, req: MsgRequest): Promise<void> {
    try {
      const result = await this.handle(client, req.cmd, (req.args ?? {}) as Record<string, unknown>);
      this.send(client.ws, { t: 'res', id: req.id, ok: true, result });
    } catch (e) {
      const code = e instanceof AgentError ? e.code : undefined;
      this.send(client.ws, { t: 'res', id: req.id, ok: false, error: errMsg(e), ...(code ? { code } : {}) });
    }
  }

  private async handle(client: Client, cmd: CommandName, args: Record<string, unknown>): Promise<unknown> {
    const a = this.agent;
    switch (cmd) {
      case 'status.get':
        return a.status();
      case 'config.apply':
        return a.applyConfig(args as never);
      case 'job.start': {
        const mode = args.mode;
        if (mode !== 'test' && mode !== 'manual' && mode !== 'scheduled') throw new Error('mode');
        return { jobId: a.startJob(mode, args.force === true) };
      }
      case 'job.cancel':
        return { cancelled: a.cancelJob() };
      case 'power': {
        const action = args.action as PowerAction;
        if (!POWER_ACTIONS.includes(action)) throw new Error('action');
        return a.power(action, Number(args.delaySec) || 0);
      }
      case 'power.cancel':
        return { cancelled: a.cancelPower() };
      case 'steam.login': {
        if (!client.sessKey) throw new Error('no session');
        const password = unseal(client.sessKey, args.password as never);
        const guard = typeof args.guardCode === 'string' && args.guardCode.trim() ? args.guardCode.trim() : undefined;
        return a.steamLogin(String(args.user ?? ''), password, guard);
      }
      case 'log.history':
        return a.log.history(Number(args.limit) || 300);
      case 'session.clean':
        return a.quickClean('manual', args.force === true);
      case 'agent.selfUpdate':
        return a.selfUpdate({ url: String(args.url ?? ''), sha256: String(args.sha256 ?? ''), version: String(args.version ?? '') });
      default:
        throw new Error(`Невідома команда: ${String(cmd)}`);
    }
  }
}
