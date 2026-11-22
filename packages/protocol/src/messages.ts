/**
 * Wire protocol between the admin app (client) and the agent (server).
 * Transport: WebSocket, text frames, one JSON object per frame.
 *
 * Handshake:
 *   agent -> admin  { t:'challenge', nonce:A, protocol }
 *   admin -> agent  { t:'auth', nonce:B, mac:HMAC(key,"auth|A|B"), client }
 *   agent -> admin  { t:'hello', proof:HMAC(key,"agent|B|A"), info, status }
 * After that:
 *   admin -> agent  { t:'req', id, cmd, args }
 *   agent -> admin  { t:'res', id, ok, result | error }
 *   agent -> admin  { t:'evt', ev, data }
 */
import { normalizeMac } from './validate';
import type {
  AgentConfigPayload,
  AgentInfo,
  AgentStatus,
  DeployExecArgs,
  DeployExecResult,
  DeployFileArgs,
  DeployFileResult,
  DiagActionResult,
  DiagBundleResult,
  DiagProcess,
  DiagScreenshotResult,
  GamesInstallResult,
  GamesUninstallResult,
  InstalledSteamGame,
  JobMode,
  LogLine,
  PendingPower,
  PowerAction,
} from './types';

/** Lightweight UDP broadcast sent by each agent (no secrets or keys) so the admin app can track DHCP IP changes by MAC. */
export interface DiscoveryBeacon {
  t: 'vade.beacon';
  v: 1;
  port: number;
  hostname: string;
  macs: string[];
}

export function parseDiscoveryBeacon(raw: string | Buffer): DiscoveryBeacon | null {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const obj = JSON.parse(text) as Partial<DiscoveryBeacon>;
    if (!obj || typeof obj !== 'object' || obj.t !== 'vade.beacon' || obj.v !== 1) return null;
    if (typeof obj.port !== 'number' || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) return null;
    const hostname = typeof obj.hostname === 'string' ? obj.hostname.trim().slice(0, 120) : '';
    if (!Array.isArray(obj.macs)) return null;
    const macs: string[] = [];
    for (const m of obj.macs) {
      if (typeof m !== 'string') continue;
      const norm = normalizeMac(m);
      if (norm && norm !== '00:00:00:00:00:00' && !macs.includes(norm)) macs.push(norm);
    }
    if (macs.length === 0) return null;
    return { t: 'vade.beacon', v: 1, port: obj.port, hostname, macs };
  } catch {
    return null;
  }
}

export interface SealedSecret {
  iv: string;
  ct: string;
  tag: string;
}

export type SteamLoginOutcome =
  | 'ok'
  | 'invalid_password'
  | 'guard_required'
  | 'guard_mismatch'
  | 'rate_limited'
  | 'timeout'
  | 'error';

export interface SteamLoginResult {
  outcome: SteamLoginOutcome;
  message: string;
}

export interface QuickCleanResult {
  /** Processes terminated */
  closed: number;
  /** Files / folders removed (or that would be, in dry-run) */
  removed: number;
  /** Locked items that could not be removed */
  failed: number;
  ms: number;
  summary: string;
}

export interface Commands {
  'status.get': { args: Record<string, never>; result: AgentStatus };
  'config.apply': { args: AgentConfigPayload; result: { changed: boolean; nextRunAt: string | null } };
  /** A PC with a player is refused (error code "occupied") unless force = true. */
  'job.start': { args: { mode: JobMode; force?: boolean }; result: { jobId: string } };
  'job.cancel': { args: Record<string, never>; result: { cancelled: boolean } };
  power: { args: { action: PowerAction; delaySec: number }; result: PendingPower };
  'power.cancel': { args: Record<string, never>; result: { cancelled: boolean } };
  'steam.login': {
    args: { user: string; password: SealedSecret; guardCode?: string };
    result: SteamLoginResult;
  };
  'log.history': { args: { limit: number }; result: LogLine[] };
  /** Post-session quick clean now: close apps, Steam logins, browser sessions. Refused on an occupied PC unless force. */
  'session.clean': { args: { force?: boolean }; result: QuickCleanResult };
  /**
   * Download the new VadeAgent.exe from url, check sha256, then replace it and restart the service
   * (rollback if the new version does not start). The connection drops while the service restarts.
   */
  'agent.selfUpdate': { args: { url: string; sha256: string; version: string }; result: { message: string } };
  /** Start w32time if stopped and run `w32tm /resync /force`. */
  'time.sync': { args: Record<string, never>; result: { ok: boolean; agentTimeMs: number; message: string } };
  'games.list': { args: Record<string, never>; result: InstalledSteamGame[] };
  'games.uninstall': { args: { appId: number; libraryPath: string }; result: GamesUninstallResult };
  'games.install': { args: { appId: number; libraryPath?: string }; result: GamesInstallResult };
  'diag.processes': { args: Record<string, never>; result: DiagProcess[] };
  'diag.killProcess': { args: { pid: number }; result: DiagActionResult };
  'diag.restartExplorer': { args: Record<string, never>; result: DiagActionResult };
  'diag.screenshot': { args: Record<string, never>; result: DiagScreenshotResult };
  'diag.bundle': { args: Record<string, never>; result: DiagBundleResult };
  'deploy.exec': { args: DeployExecArgs; result: DeployExecResult };
  'deploy.file': { args: DeployFileArgs; result: DeployFileResult };
}

export type CommandName = keyof Commands;
export type CommandArgs<C extends CommandName> = Commands[C]['args'];
export type CommandResult<C extends CommandName> = Commands[C]['result'];

export interface Events {
  status: AgentStatus;
  log: LogLine;
  'power.pending': PendingPower;
}

export type EventName = keyof Events;

export interface MsgChallenge {
  t: 'challenge';
  nonce: string;
  protocol: number;
}

export interface MsgAuth {
  t: 'auth';
  nonce: string;
  mac: string;
  client: string;
}

export interface MsgHello {
  t: 'hello';
  proof: string;
  info: AgentInfo;
  status: AgentStatus;
}

export interface MsgRequest<C extends CommandName = CommandName> {
  t: 'req';
  id: string;
  cmd: C;
  args: CommandArgs<C>;
}

export interface MsgResponse {
  t: 'res';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Machine-readable reason of an error, see ERR_* */
  code?: string;
}

/** job.start / session.clean refused: a player is on the PC (repeat with force: true to override) */
export const ERR_OCCUPIED = 'occupied';
/** Another job / clean / update is running */
export const ERR_BUSY = 'busy';
/** Downloaded agent does not match the expected sha256 */
export const ERR_HASH = 'hash_mismatch';
/** Self-update is only possible for the installed service (not dev / dry-run) */
export const ERR_NOT_SERVICE = 'not_service';

export interface MsgEvent<E extends EventName = EventName> {
  t: 'evt';
  ev: E;
  data: Events[E];
}

export type AgentToAdmin = MsgChallenge | MsgHello | MsgResponse | MsgEvent;
export type AdminToAgent = MsgAuth | MsgRequest;

/** WebSocket close codes used by the agent */
export const CLOSE_AUTH_FAILED = 4001;
export const CLOSE_AUTH_TIMEOUT = 4002;
export const CLOSE_PROTOCOL = 4003;
export const CLOSE_NOT_ALLOWED = 4004;
export const CLOSE_NOT_CONFIGURED = 4005;
