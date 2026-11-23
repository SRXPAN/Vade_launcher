import { Lock, Unlock, User } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProtectedFeature } from '../shared/access';
import type { RoleState } from '../shared/api';
import { api } from './api';
import { useI18n } from './i18n';
import { PinPromptModal } from './PinPromptModal';

const DEFAULT_ROLE_STATE: RoleState = {
  pinEnabled: false,
  role: 'operator',
  unlockedUntil: null,
  ownerSessionMin: 20,
  operatorName: '',
};

export interface RoleContextValue {
  state: RoleState;
  isOwner: boolean;
  can: (feature: ProtectedFeature) => boolean;
  requireOwner: (actionOrHint: string, fn: () => void) => void;
  openUnlock: (hint?: string) => void;
  lock: () => Promise<RoleState>;
  setOperatorName: (name: string) => Promise<RoleState>;
}

const RoleContext = createContext<RoleContextValue>({
  state: DEFAULT_ROLE_STATE,
  isOwner: true,
  can: () => true,
  requireOwner: (_hint, fn) => fn(),
  openUnlock: () => undefined,
  lock: async () => DEFAULT_ROLE_STATE,
  setOperatorName: async () => DEFAULT_ROLE_STATE,
});

interface PendingUnlock {
  hint?: string;
  fn?: () => void;
}

function fmtCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Provides active Operator/Owner role state, PIN unlock modal elevation, and operator name management. */
export function RoleProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const tr = (key: string, params?: Record<string, string | number>) => t(key as never, params);
  const [state, setState] = useState<RoleState>(DEFAULT_ROLE_STATE);
  const [pending, setPending] = useState<PendingUnlock | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getRoleState().then((s) => {
      if (alive) setState(s);
    });
    const off = api.onRoleChanged((s) => setState(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const isOwner = !state.pinEnabled || state.role === 'owner';

  const can = useCallback((_feature: ProtectedFeature) => isOwner, [isOwner]);

  const requireOwner = useCallback(
    (actionOrHint: string, fn: () => void) => {
      if (isOwner) {
        fn();
        return;
      }
      setPending({ hint: actionOrHint, fn });
    },
    [isOwner],
  );

  const openUnlock = useCallback((hint?: string) => {
    setPending({ hint });
  }, []);

  const lock = useCallback(async () => {
    const next = await api.lockOwner();
    setState(next);
    return next;
  }, []);

  const setOperatorName = useCallback(async (name: string) => {
    const next = await api.setOperatorName(name);
    setState(next);
    return next;
  }, []);

  const value = useMemo<RoleContextValue>(
    () => ({
      state,
      isOwner,
      can,
      requireOwner,
      openUnlock,
      lock,
      setOperatorName,
    }),
    [state, isOwner, can, requireOwner, openUnlock, lock, setOperatorName],
  );

  return (
    <RoleContext.Provider value={value}>
      {children}
      {pending && (
        <PinPromptModal
          title={tr('role.unlockTitle')}
          description={pending.hint || tr('role.unlockDesc')}
          verifyPin={async (pin) => {
            const res = await api.unlockOwner(pin);
            if (res.ok) setState(res.state);
            return res;
          }}
          onVerified={() => {
            const fn = pending.fn;
            setPending(null);
            fn?.();
          }}
          onClose={() => setPending(null)}
        />
      )}
    </RoleContext.Provider>
  );
}

/** Reads the active Operator/Owner role context from RoleProvider. */
export function useRole(): RoleContextValue {
  return useContext(RoleContext);
}

/** Compact topbar controls for active operator name and Operator/Owner PIN lock status. */
export function RoleControls() {
  const { t } = useI18n();
  const tr = (key: string, params?: Record<string, string | number>) => t(key as never, params);
  const { state, openUnlock, lock, setOperatorName } = useRole();

  const [popOpen, setPopOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const showCountdown = state.pinEnabled && state.role === 'owner' && state.unlockedUntil !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!showCountdown) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [showCountdown]);

  useEffect(() => {
    if (!popOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPopOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [popOpen]);

  const togglePopover = () => {
    setDraftName(state.operatorName);
    setPopOpen((prev) => !prev);
  };

  const saveName = async (nextName: string) => {
    if (savingName) return;
    setSavingName(true);
    try {
      await setOperatorName(nextName);
      setPopOpen(false);
    } finally {
      setSavingName(false);
    }
  };

  const remainingText =
    showCountdown && state.unlockedUntil !== null
      ? fmtCountdown(Math.max(0, state.unlockedUntil - nowMs))
      : null;

  return (
    <div className="role-controls">
      <div className="menu-wrap" ref={popRef}>
        <button
          type="button"
          className="btn small op-btn"
          onClick={togglePopover}
          aria-expanded={popOpen}
          title={tr('role.operatorNameLabel')}
        >
          <User size={13} />
          <span>{state.operatorName || tr('role.setOperator')}</span>
        </button>
        {popOpen && (
          <div
            className="op-popover"
            role="dialog"
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 6px)',
              minWidth: 230,
              background: 'var(--panel-2)',
              border: '1px solid var(--border-2)',
              borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow)',
              padding: 10,
              zIndex: 40,
            }}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveName(draftName);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div className="field">
                <label>{tr('role.operatorNameLabel')}</label>
                <input
                  type="text"
                  className="input"
                  autoFocus
                  maxLength={60}
                  value={draftName}
                  placeholder={tr('role.operatorPlaceholder')}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {(state.operatorName || draftName.trim()) && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={savingName}
                    onClick={() => void saveName('')}
                  >
                    {tr('role.clearOperator')}
                  </button>
                )}
                <button type="submit" className="btn small primary" disabled={savingName}>
                  {t('common.save')}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {state.pinEnabled &&
        (state.role === 'operator' ? (
          <button
            type="button"
            className="btn small role-pill role-operator"
            onClick={() => openUnlock()}
            title={tr('role.unlockHint')}
          >
            <Lock size={13} />
            <span>{tr('role.operator')}</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn small role-pill role-owner"
            onClick={() => void lock()}
            title={tr('role.lockHint')}
            style={{
              borderColor: 'var(--warn)',
              background: 'var(--warn-soft)',
              color: 'var(--warn)',
            }}
          >
            <Unlock size={13} />
            <span>{tr('role.owner')}</span>
            {remainingText && <span className="mono">{remainingText}</span>}
          </button>
        ))}
    </div>
  );
}
