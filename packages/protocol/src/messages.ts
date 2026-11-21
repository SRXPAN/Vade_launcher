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
import type {
  AgentConfigPayload,
  AgentInfo,
  AgentStatus,
  JobMode,
  LogLine,
  PendingPower,
  PowerAction,
} from './types';

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
