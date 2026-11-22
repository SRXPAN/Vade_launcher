import { Check, CircleCheck, Info, Minus, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DisplayStatus } from '@vade/protocol';
import { useI18n, type I18nKey } from './i18n';

const STATUS_KEY: Record<DisplayStatus, I18nKey> = {
  online: 'status.online',
  offline: 'status.offline',
  sleeping: 'status.sleeping',
  cleaning: 'status.cleaning',
  updating: 'status.updating',
  error: 'status.error',
};

/* ---------- status badge ---------- */
export function StatusBadge({ status }: { status: DisplayStatus }) {
  const { t } = useI18n();
  return (
    <span className={`badge st-${status}`}>
      <span className="dot" />
      {t(STATUS_KEY[status])}
    </span>
  );
}

/* ---------- switch ---------- */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function CheckBox({ state }: { state: 'on' | 'off' | 'partial' }) {
  return (
    <span className={`check ${state === 'off' ? '' : state}`}>
      {state === 'on' && <Check size={13} strokeWidth={3} />}
      {state === 'partial' && <Minus size={13} strokeWidth={3} />}
    </span>
  );
}

/* ---------- toggle option row ---------- */
export function Option(props: { title: string; desc?: ReactNode; on: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <div className="opt">
      <div className="opt-text">
        <div className="opt-title">{props.title}</div>
        {props.desc && <div className="opt-desc">{props.desc}</div>}
        {props.on && props.children && <div className="opt-extra">{props.children}</div>}
      </div>
      <Switch on={props.on} onChange={props.onChange} disabled={props.disabled} label={props.title} />
    </div>
  );
}

/* ---------- segmented ---------- */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- modal ---------- */
export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  const { t } = useI18n();
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {props.icon}
          <h3>{props.title}</h3>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: { title: string; text: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      icon={<TriangleAlert size={18} color={props.danger ? 'var(--err)' : 'var(--warn)'} />}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn ${props.danger ? 'danger solid' : 'primary'}`}
            autoFocus
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="muted">{props.text}</div>
    </Modal>
  );
}

/* ---------- popover menu ---------- */
export function Menu({ trigger, children, down }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      {trigger(() => setOpen((v) => !v))}
      {open && <div className={`menu ${down ? 'down' : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ---------- toasts ---------- */
type ToastKind = 'info' | 'ok' | 'warn' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
const ToastCtx = createContext<(kind: ToastKind, text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-4), { id, kind, text }]);
    setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            {item.kind === 'ok' ? <CircleCheck size={16} color="var(--ok)" /> : item.kind === 'info' ? <Info size={16} color="var(--accent)" /> : <TriangleAlert size={16} color={item.kind === 'error' ? 'var(--err)' : 'var(--warn)'} />}
            <span>{item.text}</span>
            <button onClick={() => setItems((l) => l.filter((x) => x.id !== item.id))} aria-label={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ---------- clock ---------- */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
