/**
 * Access-control helpers and RoleController (Operator / Owner PIN session state machine).
 */
import { EventEmitter as NodeEventEmitter } from 'node:events';
import type { AdminRole } from '@vade/protocol';
import type { PcAction, RoleState } from './api';

export type ProtectedFeature =
  | 'map.edit'
  | 'pc.edit'
  | 'settings.edit'
  | 'deploy'
  | 'agent.update'
  | 'backup'
  | 'power.occupied';

const OWNER_OCCUPIED_ACTIONS = new Set<PcAction>([
  'shutdown',
  'restart',
  'sleep',
  'hibernate',
  'test',
  'run',
  'clean-logins',
]);

const DEFAULT_SESSION_MIN = 20;
const MIN_SESSION_MIN = 1;
const MAX_SESSION_MIN = 240;
const MAX_OPERATOR_NAME_LEN = 60;

// Browser-safe fallback so importing pure helpers in the renderer never crashes if node:events is externalised.
const EventEmitterBase: typeof NodeEventEmitter =
  typeof NodeEventEmitter === 'function'
    ? NodeEventEmitter
    : (class {} as unknown as typeof NodeEventEmitter);

function clampSessionMin(minutes: number): number {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return DEFAULT_SESSION_MIN;
  return Math.min(MAX_SESSION_MIN, Math.max(MIN_SESSION_MIN, Math.round(n)));
}

function normalizeOperatorName(name: string): string {
  return String(name ?? '').trim().slice(0, MAX_OPERATOR_NAME_LEN);
}

/** Returns true when PIN protection is disabled or the current role is Owner. */
export function isFeatureAllowed(role: AdminRole, pinEnabled: boolean, _feature: ProtectedFeature): boolean {
  return !pinEnabled || role === 'owner';
}

/**
 * Determines whether a PC action requires Owner elevation because players are seated on target PCs.
 */
export function requiresOwnerForAction(opts: {
  pinEnabled: boolean;
  role: AdminRole;
  action: PcAction;
  occupiedCount: number;
  force?: boolean;
}): boolean {
  if (!opts.pinEnabled || opts.role !== 'operator') return false;
  if (opts.occupiedCount <= 0) return false;
  return Boolean(opts.force) || OWNER_OCCUPIED_ACTIONS.has(opts.action);
}

export interface RoleControllerDeps {
  isPinEnabled: () => boolean;
  verifyPin: (pin: string) => boolean;
  getSessionMin: () => number;
  initialOperatorName?: string;
  onOperatorNameSaved?: (name: string) => void;
  onAudit?: (action: 'role.unlock' | 'role.lock', details?: string) => void;
  now?: () => number;
}

/**
 * Tracks active Operator/Owner mode, PIN unlock TTL, and active operator name in the main process.
 * Always starts in 'operator' mode whenever PIN protection is enabled.
 */
export class RoleController extends EventEmitterBase<{ changed: [RoleState] }> {
  private readonly deps: RoleControllerDeps;
  private readonly now: () => number;
  private unlockedUntil: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operatorName: string;

  constructor(deps: RoleControllerDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.operatorName = normalizeOperatorName(deps.initialOperatorName ?? '');
  }

  /** Computes the current RoleState, checking any active unlock TTL against now(). */
  state(): RoleState {
    const pinEnabled = this.deps.isPinEnabled();
    const ownerSessionMin = clampSessionMin(this.deps.getSessionMin());
    const isUnlocked = pinEnabled && this.unlockedUntil !== null && this.now() < this.unlockedUntil;
    const role: AdminRole = !pinEnabled || isUnlocked ? 'owner' : 'operator';
    return {
      pinEnabled,
      role,
      unlockedUntil: role === 'owner' && pinEnabled ? this.unlockedUntil : null,
      ownerSessionMin,
      operatorName: this.operatorName,
    };
  }

  /** Verifies PIN and elevates the session to Owner mode for the configured TTL. */
  unlock(pin: string): { ok: boolean; state: RoleState; error?: string } {
    if (!this.deps.verifyPin(pin)) {
      return { ok: false, state: this.state(), error: 'Невірний PIN-код' };
    }
    this.clearTimer();
    if (!this.deps.isPinEnabled()) {
      this.unlockedUntil = null;
      const next = this.state();
      this.emit('changed', next);
      return { ok: true, state: next };
    }

    const sessionMin = clampSessionMin(this.deps.getSessionMin());
    const ms = sessionMin * 60_000;
    this.unlockedUntil = this.now() + ms;
    const timer = setTimeout(() => {
      this.timer = null;
      this.lock('timeout');
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;

    const next = this.state();
    this.emit('changed', next);
    this.deps.onAudit?.('role.unlock', `${sessionMin} min`);
    return { ok: true, state: next };
  }

  /** Drops Owner elevation back to Operator mode (when PIN is enabled) and cancels any expiry timer. */
  lock(reason?: string): RoleState {
    const wasUnlocked = this.unlockedUntil !== null;
    this.clearTimer();
    this.unlockedUntil = null;
    const next = this.state();
    this.emit('changed', next);
    if (wasUnlocked && next.pinEnabled) {
      this.deps.onAudit?.('role.lock', reason);
    }
    return next;
  }

  /** Reconciles role state after PIN settings change (e.g. PIN enabled or disabled). */
  syncPinConfig(): RoleState {
    if (!this.deps.isPinEnabled()) {
      this.clearTimer();
      this.unlockedUntil = null;
    }
    const next = this.state();
    this.emit('changed', next);
    return next;
  }

  /** Updates the active shift operator display name (trimmed, max 60 chars). */
  setOperatorName(name: string): RoleState {
    const clean = normalizeOperatorName(name);
    this.operatorName = clean;
    this.deps.onOperatorNameSaved?.(clean);
    const next = this.state();
    this.emit('changed', next);
    return next;
  }

  /** Throws unless the caller currently has permission for the requested protected feature. */
  requireOwner(feature: ProtectedFeature): void {
    const st = this.state();
    if (!isFeatureAllowed(st.role, st.pinEnabled, feature)) {
      throw new Error('Потрібен режим «Власник» (введіть PIN-код)');
    }
  }

  /** Stops the auto-lock timer during application shutdown. */
  stop(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
