/** Hover card and context menu of a PC on the club map (HTML overlays above the SVG). */
import {
  BrushCleaning,
  CircleStop,
  KeyRound,
  ListChecks,
  Moon,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  PowerOff,
  RotateCcw,
  ScrollText,
  Snowflake,
  TimerOff,
  Zap,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  compareVersions,
  deriveDisplayStatus,
  diskLevel,
  formatGb,
  STEP_TITLES,
  type AppSettings,
  type PcRecord,
  type PcRuntime,
} from '@vade/protocol';
import type { PcAction } from '../../shared/api';
import { fmtAgo, fmtDateTime, fmtTime, occupancyText, RESULT_LABEL, scheduleLabel } from '../format';
import { StatusBadge } from '../ui';
import { clamp } from './mapEdit';
import { TONE_COLOR, TONE_LABEL, type MapTone } from './mapStatus';

export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Absolutely positioned box next to an anchor, kept inside the map viewport. */
export function Floating(props: { anchor: Anchor; bounds: { w: number; h: number }; className: string; children: ReactNode; innerRef?: Ref<HTMLDivElement> }) {
  const { anchor, bounds } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    const m = 8;
    let left = anchor.right + gap;
    if (left + w > bounds.w - m) left = anchor.left - gap - w;
    left = clamp(left, m, Math.max(m, bounds.w - w - m));
    const top = clamp(anchor.top, m, Math.max(m, bounds.h - h - m));
    if (!pos || pos.left !== left || pos.top !== top) setPos({ left, top });
  });
  return (
    <div
      ref={(el) => {
        ref.current = el;
        const r = props.innerRef;
        if (typeof r === 'function') r(el);
        else if (r) (r as { current: HTMLDivElement | null }).current = el;
      }}
      className={props.className}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {props.children}
    </div>
  );
}

interface TooltipProps {
  id: number;
  pc: PcRecord | undefined;
  rt: PcRuntime | undefined;
  tone: MapTone;
  settings: AppSettings;
  runState: string | null;
  latestAgentVersion: string | null;
}

export function PcTooltip({ id, pc, rt, tone, settings, runState, latestAgentVersion }: TooltipProps) {
  if (!pc) {
    return (
      <>
        <div className="mt-head">
          <span className="mt-num">№{id}</span>
          <span className="mt-chip">вільне місце</span>
        </div>
        <div className="mt-row dim">ПК з цим номером ще не додано в базу. Клікніть, щоб додати.</div>
      </>
    );
  }
  const online = rt?.link === 'online';
  const st = online ? rt?.status : null;
  const version = rt?.info?.version;
  const outdated = !!version && !!latestAgentVersion && compareVersions(version, latestAgentVersion) < 0;
  const host = pc.name || rt?.info?.hostname;
  const job = st?.job ?? null;
  const running = job?.steps.find((s) => s.status === 'running');
  const last = st?.lastJob ?? rt?.status?.lastJob ?? null;
  const slot = scheduleLabel(settings, pc);
  const wolRecent = !online && rt?.wolSentAt && Date.now() - new Date(rt.wolSentAt).getTime() < 5 * 60_000;

  return (
    <>
      <div className="mt-head">
        <span className="mt-num">№{pc.id}</span>
        <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
        <span className="spacer" />
        <StatusBadge status={deriveDisplayStatus(rt)} />
      </div>
      <div className="mt-row mt-sub">
        <span className="ellipsis">{host ?? (rt?.lastSeen ? `був онлайн ${fmtAgo(rt.lastSeen)}` : 'агент ще не підключався')}</span>
        {version && (
          <span className={outdated ? 'ver-old' : 'dim'} title={outdated ? `Доступна версія ${latestAgentVersion}` : undefined}>
            агент v{version}
          </span>
        )}
      </div>
      <div className="mt-row mono dim">
        {pc.ip} · {pc.mac}
      </div>
      <div className="mt-row">
        <span className="mt-dot" style={{ background: TONE_COLOR[tone] }} />
        <b>{TONE_LABEL[tone]}</b>
      </div>
      {tone === 'busy' && <div className="mt-row dim">{occupancyText(rt)}</div>}
      {st?.disks && st.disks.length > 0 && (
        <div className="mt-row mt-disks">
          {st.disks.map((d, i) => (
            <span key={d.drive}>
              {i > 0 && <span className="dim"> | </span>}
              <span className={`disk-${diskLevel(d.freeBytes, settings.alerts)}`} title={`вільно з ${formatGb(d.totalBytes)}`}>
                {d.drive} {formatGb(d.freeBytes)}
              </span>
            </span>
          ))}
        </div>
      )}
      {job ? (
        <div className="mt-row" style={{ color: TONE_COLOR.work }}>
          {running ? STEP_TITLES[running.id] : 'Обслуговування'}
          {job.progress && ` · ${job.progress.appId} ${job.progress.pct.toFixed(0)}%`}
        </div>
      ) : st?.state === 'steam-login' ? (
        <div className="mt-row" style={{ color: TONE_COLOR.work }}>
          Вхід SteamCMD…
        </div>
      ) : null}
      <div className={`mt-row ${last?.result === 'errors' ? 'mt-err' : ''}`}>
        <span className="dim">Останнє обслуговування:</span>
        {last ? `${last.result ? RESULT_LABEL[last.result] : 'триває'} · ${fmtDateTime(last.finishedAt ?? last.startedAt)}` : 'ще не було'}
      </div>
      <div className="mt-row">
        <span className="dim">Наступний слот:</span>
        {st?.nextRunAt ? fmtDateTime(st.nextRunAt) : (slot ?? 'не в нічному розкладі')}
      </div>
      {st?.pendingPower && <div className="mt-row mt-warn">Дія живлення о {fmtTime(st.pendingPower.at)}</div>}
      {st?.quickCleanAt && <div className="mt-row mt-warn">Очищення логінів о {fmtTime(st.quickCleanAt)}</div>}
      {runState && <div className="mt-row" style={{ color: 'var(--accent)' }}>{runState}</div>}
      {wolRecent && <div className="mt-row dim">WoL надіслано о {fmtTime(rt!.wolSentAt)}</div>}
      {(rt?.link === 'auth-failed' || rt?.link === 'incompatible') && rt.lastError && <div className="mt-row mt-err">{rt.lastError}</div>}
    </>
  );
}

interface MenuProps {
  id: number;
  pc: PcRecord | undefined;
  rt: PcRuntime | undefined;
  tone: MapTone;
  selected: boolean;
  outdated: boolean;
  onClose: () => void;
  onAction: (a: PcAction, ids: number[]) => void;
  onLogs: (id: number) => void;
  onEdit: (pc: PcRecord) => void;
  onSteam: (ids: number[]) => void;
  onUpdateAgent: (ids: number[]) => void;
  onToggleSelect: (id: number) => void;
  onAdd: (id: number) => void;
}

export function PcMenu(p: MenuProps) {
  const run = (fn: () => void) => () => {
    p.onClose();
    fn();
  };
  if (!p.pc) {
    return (
      <>
        <div className="mm-head">
          <b>Місце №{p.id}</b>
          <span className="dim">ПК не додано</span>
        </div>
        <button onClick={run(() => p.onAdd(p.id))}>
          <Plus size={15} /> Додати ПК №{p.id}…
        </button>
      </>
    );
  }
  const pc = p.pc;
  const online = p.rt?.link === 'online';
  const st = online ? p.rt?.status : null;
  const busy = !!st?.job;
  const act = (a: PcAction) => run(() => p.onAction(a, [pc.id]));
  const item = (label: string, icon: ReactNode, onClick: () => void, opts: { disabled?: boolean; danger?: boolean; title?: string } = {}) => (
    <button className={opts.danger ? 'danger' : ''} disabled={opts.disabled} title={opts.title} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
  const offlineHint = online ? undefined : 'ПК не на зв’язку';
  return (
    <>
      <div className="mm-head">
        <b>ПК №{pc.id}</b>
        <span className="mt-dot" style={{ background: TONE_COLOR[p.tone] }} />
        <span className="dim">{TONE_LABEL[p.tone]}</span>
      </div>
      {item('Обслуговування зараз', <Play size={15} />, act('test'), { disabled: !online || busy, title: busy ? 'Уже виконується завдання' : offlineHint })}
      {item('Очистити логіни зараз', <BrushCleaning size={15} />, act('clean-logins'), { disabled: !online || busy, title: offlineHint })}
      {item('Відкрити живий лог', <ScrollText size={15} />, run(() => p.onLogs(pc.id)))}
      <hr />
      {item('Увімкнути (WoL)', <Zap size={15} />, act('wake'))}
      <div className="mm-pair">
        {item('Сон', <Moon size={15} />, act('sleep'), { disabled: !online, title: offlineHint })}
        {item('Гібернація', <Snowflake size={15} />, act('hibernate'), { disabled: !online, title: offlineHint })}
      </div>
      <div className="mm-pair">
        {item('Перезавантажити', <RotateCcw size={15} />, act('restart'), { disabled: !online, danger: true, title: offlineHint })}
        {item('Вимкнути', <PowerOff size={15} />, act('shutdown'), { disabled: !online, danger: true, title: offlineHint })}
      </div>
      <hr />
      {item('Вхід SteamCMD', <KeyRound size={15} />, run(() => p.onSteam([pc.id])), { disabled: !online, title: offlineHint })}
      {busy && item('Скасувати завдання', <CircleStop size={15} />, act('cancel'))}
      {st?.pendingPower && item('Скасувати вимкнення', <TimerOff size={15} />, act('cancel-power'))}
      {online && p.outdated && item('Оновити агент…', <PackageOpen size={15} />, run(() => p.onUpdateAgent([pc.id])))}
      {item('Редагувати ПК', <Pencil size={15} />, run(() => p.onEdit(pc)))}
      <hr />
      {item(p.selected ? 'Прибрати з вибору' : 'Додати до вибору', <ListChecks size={15} />, run(() => p.onToggleSelect(pc.id)))}
    </>
  );
}
