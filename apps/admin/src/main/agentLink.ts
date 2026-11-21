import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  CLOSE_AUTH_FAILED,
  CLOSE_NOT_ALLOWED,
  CLOSE_NOT_CONFIGURED,
  PROTOCOL_VERSION,
  type AgentInfo,
  type AgentStatus,
  type AgentToAdmin,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type LinkState,
  type LogLine,
  type PendingPower,
  type SealedSecret,
} from '@vade/protocol';
import { agentProof, authMac, newNonce, safeEqual, seal, sessionKey } from '@vade/protocol/auth';

export interface LinkOptions {
  host: string;
  port: number;
  clubKey: string;
  clientName: string;
}

export interface AgentLinkEvents {
  link: [LinkState];
  hello: [AgentInfo, AgentStatus];
  status: [AgentStatus];
  log: [LogLine];
  'power.pending': [PendingPower];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PING_MS = 5000;
const HANDSHAKE_MS = 3000;

/**
 * One persistent, self-healing connection from the admin app to one agent.
 * Knows nothing about Electron, so it is covered by integration tests.
 */
export class AgentLink extends EventEmitter<AgentLinkEvents> {
  state: LinkState = 'offline';
  lastError: string | null = null;
  /** IP of the admin PC on the route to this agent (used in OTA update URLs) */
  localAddress: string | null = null;
  private ws: WebSocket | null = null;
  private stopped = true;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = false;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private sessKey: Buffer | null = null;

  constructor(readonly opts: LinkOptions) {
    super();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.terminate();
    this.ws = null;
    this.setState('offline');
  }

  /** Skip the back-off and try now (e.g. right after Wake-on-LAN). */
  retrySoon(delayMs = 1000): void {
    if (this.stopped || this.state === 'online' || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.failures = 0;
    this.retryTimer = setTimeout(() => this.connect(), delayMs);
  }

  request<C extends CommandName>(cmd: C, args: CommandArgs<C>, timeoutMs = 15_000): Promise<CommandResult<C>> {
    const ws = this.ws;
    if (!ws || this.state !== 'online') return Promise.reject(new Error("Агент не на зв'язку"));
    const id = String(++this.seq);
    return new Promise<CommandResult<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Агент не відповів вчасно'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ t: 'req', id, cmd, args }));
    });
  }

  /** Encrypts a secret (Steam password) with this connection's session key. */
  sealSecret(plaintext: string): SealedSecret {
    if (!this.sessKey) throw new Error("Агент не на зв'язку");
    return seal(this.sessKey, plaintext);
  }

  private setState(s: LinkState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('link', s);
  }

  private connect(): void {
    this.retryTimer = null;
    if (this.stopped) return;
    const { host, port, clubKey, clientName } = this.opts;
    if (this.state !== 'auth-failed' && this.state !== 'incompatible') this.setState('connecting');
    const ws = new WebSocket(`ws://${host}:${port}/`, { handshakeTimeout: HANDSHAKE_MS, perMessageDeflate: false });
    this.ws = ws;
    let agentNonce = '';
    let adminNonce = '';
    let closeKind: LinkState | null = null;

    ws.on('message', (raw) => {
      let msg: AgentToAdmin;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.t) {
        case 'challenge':
          if (msg.protocol !== PROTOCOL_VERSION) {
            this.lastError = `Несумісна версія протоколу агента (${msg.protocol}, потрібна ${PROTOCOL_VERSION})`;
            closeKind = 'incompatible';
            ws.terminate();
            return;
          }
          agentNonce = msg.nonce;
          adminNonce = newNonce();
          ws.send(JSON.stringify({ t: 'auth', nonce: adminNonce, mac: authMac(clubKey, agentNonce, adminNonce), client: clientName }));
          return;
        case 'hello':
          if (!agentNonce || !safeEqual(String(msg.proof), agentProof(clubKey, agentNonce, adminNonce))) {
            this.lastError = 'Агент не підтвердив ключ клубу (можлива підміна)';
            closeKind = 'auth-failed';
            ws.terminate();
            return;
          }
          this.sessKey = sessionKey(clubKey, agentNonce, adminNonce);
          this.failures = 0;
          this.lastError = null;
          this.alive = true;
          this.startPing(ws);
          this.setState('online');
          this.emit('hello', msg.info, msg.status);
          return;
        case 'res': {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(Object.assign(new Error(msg.error ?? 'Помилка агента'), msg.code ? { code: msg.code } : {}));
          return;
        }
        case 'evt':
          if (msg.ev === 'status') this.emit('status', msg.data as AgentStatus);
          else if (msg.ev === 'log') this.emit('log', msg.data as LogLine);
          else if (msg.ev === 'power.pending') this.emit('power.pending', msg.data as PendingPower);
          return;
      }
    });
    ws.on('upgrade', (res) => {
      this.localAddress = (res.socket.localAddress ?? '').replace(/^::ffff:/, '') || null;
    });
    ws.on('pong', () => (this.alive = true));
    ws.on('error', (e: Error & { code?: string }) => {
      if (this.state !== 'online') this.lastError = describeError(e);
    });
    ws.on('close', (code) => {
      if (code === CLOSE_AUTH_FAILED) {
        closeKind = 'auth-failed';
        this.lastError = 'Невірний ключ клубу: агент відхилив підключення';
      } else if (code === CLOSE_NOT_CONFIGURED) {
        closeKind = 'auth-failed';
        this.lastError = 'На агенті не налаштовано ключ клубу';
      } else if (code === CLOSE_NOT_ALLOWED) {
        closeKind = 'auth-failed';
        this.lastError = "Агент не приймає з'єднання з IP цього ПК (allowFrom)";
      }
      this.onClosed(ws, closeKind);
    });
  }

  private startPing(ws: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.alive) {
        this.lastError = 'Агент перестав відповідати';
        ws.terminate();
        return;
      }
      this.alive = false;
      try {
        ws.ping();
      } catch {
        // close handler follows
      }
    }, PING_MS);
  }

  private onClosed(ws: WebSocket, kind: LinkState | null): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.sessKey = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("З'єднання з агентом втрачено"));
      this.pending.delete(id);
    }
    if (this.stopped) return;
    this.setState(kind ?? 'offline');
    this.failures++;
    const delay = kind ? 30_000 : Math.min(2000 * 2 ** Math.min(this.failures - 1, 3), 15_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

function describeError(e: Error & { code?: string }): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'Агент не запущений (порт закритий)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'ПК недоступний у мережі';
    case 'ETIMEDOUT':
      return 'ПК не відповідає';
    default:
      return /handshake has timed out/i.test(e.message) ? 'ПК не відповідає' : e.message;
  }
}
