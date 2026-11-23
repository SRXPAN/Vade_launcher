/** Hover card, view-mode PC menu, and edit-mode context menu on the club map. */
import {
  Activity,
  BrushCleaning,
  CircleStop,
  Clock,
  KeyRound,
  Link2,
  ListChecks,
  MessageSquare,
  Monitor,
  Moon,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  PowerOff,
  RotateCcw,
  RotateCw,
  ScrollText,
  Snowflake,
  StickyNote,
  TimerOff,
  Trash2,
  Unlink,
  Wrench,
  Zap,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  clockDriftSec,
  compareVersions,
  deriveDisplayStatus,
  diskLevel,
  evaluateHealth,
  formatClockDrift,
  formatGb,
  isClockDrifted,
  STEP_TITLES,
  type AppSettings,
  type PcRecord,
  type PcRuntime,
  type RestartLauncherApp,
} from '@vade/protocol';
import type { PcAction } from '../../shared/api';
import { LANDMARK_TITLES, type MapLabel, type MapLandmark, type MapZoneBox } from '../../shared/mapLayout';
import { fmtAgo, fmtDateTime, fmtTime, occupancyText, RESULT_LABEL, scheduleLabel } from '../format';
import { useI18n } from '../i18n';
import { StatusBadge } from '../ui';
import { clamp, type EditItemRef } from './mapEdit';
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
  const { t } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  if (!pc) {
    return (
      <>
        <div className="mt-head">
          <span className="mt-num">№{id}</span>
          <span className="mt-chip">резервний слот</span>
        </div>
        <div className="mt-row dim">ПК з цим номером ще не додано в базу. Клікніть, щоб прив’язати або створити ПК.</div>
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
  const health = st?.health;
  const hwIssues = health ? evaluateHealth(health, settings.alerts, pc.zone) : [];
  const drift = online ? clockDriftSec(st?.agentTimeMs) : null;
  const drifted = online && isClockDrifted(st?.agentTimeMs);
  const worstSsdWear = health?.ssd.reduce<number | null>((acc, d) => (d.wearPct != null && (acc == null || d.wearPct > acc) ? d.wearPct : acc), null) ?? null;

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
      {pc.serviceNote?.outOfService && (
        <div className="mt-row mt-repair" style={{ color: 'var(--occ)', fontWeight: 600 }}>
          <Wrench size={13} style={{ flexShrink: 0 }} />
          <span>{tr('note.repairBadge')}</span>
        </div>
      )}
      {pc.serviceNote?.text?.trim() && (
        <div className="mt-row mt-note" style={{ color: 'var(--warn)', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <StickyNote size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            {pc.serviceNote.text.trim()}
            {pc.serviceNote.author ? <span className="dim"> · {pc.serviceNote.author}</span> : null}
          </span>
        </div>
      )}
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
      {health && (
        <div className="mt-row mt-hw">
          <span className={hwIssues.some((i) => i.kind === 'ram') ? 'mt-err' : undefined}>RAM {health.ramTotalGb} ГБ</span>
          {health.refreshRateHz != null && (
            <span className={hwIssues.some((i) => i.kind === 'refreshRate') ? 'mt-warn' : undefined}>· {health.refreshRateHz} Гц</span>
          )}
          {health.gpuTempC != null && (
            <span className={hwIssues.some((i) => i.kind === 'gpuTemp') ? 'mt-warn' : undefined}>· GPU {health.gpuTempC}°C</span>
          )}
          {worstSsdWear != null && (
            <span className={hwIssues.some((i) => i.kind === 'ssdWear' || i.kind === 'ssdHealth') ? 'mt-warn' : undefined}>· SSD знос {worstSsdWear}%</span>
          )}
        </div>
      )}
      {hwIssues.map((issue, idx) => (
        <div key={idx} className={`mt-row ${issue.level === 'crit' ? 'mt-err' : 'mt-warn'}`}>
          ⚠ {issue.message}
        </div>
      ))}
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
      {drifted && drift != null && <div className="mt-row mt-warn">Збитий час ({formatClockDrift(drift)})</div>}
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
  unplacedCount: number;
  onClose: () => void;
  onAction: (a: PcAction, ids: number[]) => void;
  onLogs: (id: number) => void;
  onDiag: (id: number) => void;
  onEdit: (pc: PcRecord) => void;
  onSteam: (ids: number[]) => void;
  onUpdateAgent: (ids: number[]) => void;
  onToggleSelect: (id: number) => void;
  onAdd: (id: number) => void;
  onBindSlot: (slotId: number) => void;
  onToggleRepair?: (pc: PcRecord) => void;
  onEditNote?: (pc: PcRecord) => void;
  onNotify?: (pc: PcRecord) => void;
  onRestoreHz?: (pc: PcRecord) => void;
  onRestartLauncher?: (pc: PcRecord, app: RestartLauncherApp) => void;
  targetHz?: number;
}

export function PcMenu(p: MenuProps) {
  const { t } = useI18n();
  const tr = (k: string, params?: Record<string, string | number>) => t(k as never, params);
  const run = (fn: () => void) => () => {
    p.onClose();
    fn();
  };
  if (!p.pc) {
    return (
      <>
        <div className="mm-head">
          <b>Місце №{p.id}</b>
          <span className="dim">резервний слот</span>
        </div>
        <button onClick={run(() => p.onAdd(p.id))}>
          <Plus size={15} /> <span>Створити ПК №{p.id}…</span>
        </button>
        <button onClick={run(() => p.onBindSlot(p.id))}>
          <Link2 size={15} /> <span>Прив’язати існуючий ПК{p.unplacedCount > 0 ? ` (${p.unplacedCount})` : ''}…</span>
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
      {item(t('action.test'), <Play size={15} />, act('test'), { disabled: !online || busy, title: busy ? 'Уже виконується завдання' : offlineHint })}
      {item(t('action.cleanLogins'), <BrushCleaning size={15} />, act('clean-logins'), { disabled: !online || busy, title: offlineHint })}
      {item(t('pcs.quickDiag'), <Activity size={15} />, run(() => p.onDiag(pc.id)), { disabled: !online, title: offlineHint })}
      {item(t('pcs.liveLog'), <ScrollText size={15} />, run(() => p.onLogs(pc.id)))}
      {(p.onNotify || p.onRestoreHz || p.onRestartLauncher) && (
        <>
          <hr />
          {p.onNotify && item(tr('diag.notifyAction'), <MessageSquare size={15} />, run(() => p.onNotify!(pc)), { disabled: !online, title: offlineHint })}
          {p.onRestoreHz &&
            item(tr('diag.restoreHzAction', { hz: p.targetHz ?? 240 }), <Monitor size={15} />, run(() => p.onRestoreHz!(pc)), {
              disabled: !online,
              title: offlineHint,
            })}
          {p.onRestartLauncher && (
            <>
              {item(tr('diag.restartSteam'), <RotateCw size={15} />, run(() => p.onRestartLauncher!(pc, 'steam')), { disabled: !online, title: offlineHint })}
              {item(tr('diag.restartRiot'), <RotateCw size={15} />, run(() => p.onRestartLauncher!(pc, 'riot')), { disabled: !online, title: offlineHint })}
            </>
          )}
        </>
      )}
      <hr />
      {item(t('action.wake'), <Zap size={15} />, act('wake'))}
      <div className="mm-pair">
        {item(t('action.sleep'), <Moon size={15} />, act('sleep'), { disabled: !online, title: offlineHint })}
        {item(t('action.hibernate'), <Snowflake size={15} />, act('hibernate'), { disabled: !online, title: offlineHint })}
      </div>
      <div className="mm-pair">
        {item(t('action.restart'), <RotateCcw size={15} />, act('restart'), { disabled: !online, danger: true, title: offlineHint })}
        {item(t('action.shutdown'), <PowerOff size={15} />, act('shutdown'), { disabled: !online, danger: true, title: offlineHint })}
      </div>
      <hr />
      {item(t('pcs.steamLogin'), <KeyRound size={15} />, run(() => p.onSteam([pc.id])), { disabled: !online, title: offlineHint })}
      {item(t('action.syncTime'), <Clock size={15} />, act('sync-time'), { disabled: !online, title: offlineHint })}
      {busy && item(t('action.cancel'), <CircleStop size={15} />, act('cancel'))}
      {st?.pendingPower && item(t('action.cancelPower'), <TimerOff size={15} />, act('cancel-power'))}
      {online && p.outdated && item(t('pcs.updateAgentAction'), <PackageOpen size={15} />, run(() => p.onUpdateAgent([pc.id])))}
      {item(t('pcs.editPc'), <Pencil size={15} />, run(() => p.onEdit(pc)))}
      {(p.onToggleRepair || p.onEditNote) && (
        <>
          <hr />
          {p.onToggleRepair &&
            item(pc.serviceNote?.outOfService ? tr('note.clearRepair') : tr('note.markRepair'), <Wrench size={15} />, run(() => p.onToggleRepair!(pc)))}
          {p.onEditNote && item(pc.serviceNote ? tr('note.editNote') : tr('note.addNote'), <StickyNote size={15} />, run(() => p.onEditNote!(pc)))}
        </>
      )}
      <hr />
      {item(p.selected ? 'Прибрати з вибору' : 'Додати до вибору', <ListChecks size={15} />, run(() => p.onToggleSelect(pc.id)))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Edit-mode context menu                                              */
/* ------------------------------------------------------------------ */

interface EditMenuProps {
  item: EditItemRef;
  pc?: PcRecord;
  landmark?: MapLandmark;
  label?: MapLabel;
  zone?: MapZoneBox;
  unplacedCount: number;
  onClose: () => void;
  onEditPc: (pc: PcRecord) => void;
  onCreatePcOnSlot: (slotId: number) => void;
  onBindSlot: (slotId: number) => void;
  onRemovePcFromMap: (id: number) => void;
  onRotateLandmark: (id: string) => void;
  onRemoveLandmark: (id: string) => void;
  onEditLabel: (label: MapLabel) => void;
  onRemoveLabel: (id: string) => void;
  onEditZone: (zone: MapZoneBox) => void;
  onRemoveZone: (id: string) => void;
}

export function EditContextMenu(p: EditMenuProps) {
  const run = (fn: () => void) => () => {
    p.onClose();
    fn();
  };

  if (p.item.type === 'pc') {
    const id = p.item.id;
    if (p.pc) {
      const pc = p.pc;
      return (
        <>
          <div className="mm-head">
            <b>ПК №{pc.id}</b>
            <span className="dim">{pc.zone}</span>
          </div>
          <button onClick={run(() => p.onEditPc(pc))}>
            <Pencil size={15} /> <span>Редагувати ПК…</span>
          </button>
          <hr />
          <button className="danger" onClick={run(() => p.onRemovePcFromMap(id))} title="ПК залишиться у pcs.json, знімуться лише координати">
            <Unlink size={15} /> <span>Прибрати ПК з карти</span>
          </button>
        </>
      );
    }
    return (
      <>
        <div className="mm-head">
          <b>Слот №{id}</b>
          <span className="dim">резерв</span>
        </div>
        <button onClick={run(() => p.onCreatePcOnSlot(id))}>
          <Plus size={15} /> <span>Створити новий ПК №{id}…</span>
        </button>
        <button onClick={run(() => p.onBindSlot(id))}>
          <Link2 size={15} /> <span>Прив’язати існуючий ПК{p.unplacedCount > 0 ? ` (${p.unplacedCount})` : ''}…</span>
        </button>
        <hr />
        <button className="danger" onClick={run(() => p.onRemovePcFromMap(id))}>
          <Trash2 size={15} /> <span>Видалити слот</span>
        </button>
      </>
    );
  }

  if (p.item.type === 'landmark' && p.landmark) {
    const lm = p.landmark;
    return (
      <>
        <div className="mm-head">
          <b>{LANDMARK_TITLES[lm.kind]}</b>
          <span className="dim">{lm.rot}°</span>
        </div>
        <button onClick={run(() => p.onRotateLandmark(lm.id))}>
          <RotateCw size={15} /> <span>Повернути на 90° (R)</span>
        </button>
        <hr />
        <button className="danger" onClick={run(() => p.onRemoveLandmark(lm.id))}>
          <Trash2 size={15} /> <span>Видалити орієнтир</span>
        </button>
      </>
    );
  }

  if (p.item.type === 'label' && p.label) {
    const lbl = p.label;
    return (
      <>
        <div className="mm-head">
          <b>Підпис</b>
          <span className="dim">{lbl.text}</span>
        </div>
        <button onClick={run(() => p.onEditLabel(lbl))}>
          <Pencil size={15} /> <span>Редагувати підпис…</span>
        </button>
        <hr />
        <button className="danger" onClick={run(() => p.onRemoveLabel(lbl.id))}>
          <Trash2 size={15} /> <span>Видалити підпис</span>
        </button>
      </>
    );
  }

  if (p.item.type === 'zone' && p.zone) {
    const z = p.zone;
    return (
      <>
        <div className="mm-head">
          <span className="mt-dot" style={{ background: z.color }} />
          <b>Зона «{z.name}»</b>
          <span className="dim">
            {z.w}×{z.h}
          </span>
        </div>
        <button onClick={run(() => p.onEditZone(z))}>
          <Pencil size={15} /> <span>Налаштувати зону…</span>
        </button>
        <hr />
        <button className="danger" onClick={run(() => p.onRemoveZone(z.id))}>
          <Trash2 size={15} /> <span>Видалити рамку зони</span>
        </button>
      </>
    );
  }

  return null;
}
