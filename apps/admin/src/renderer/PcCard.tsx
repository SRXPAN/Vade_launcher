import {
  Activity,
  CircleStop,
  Clock,
  Ellipsis,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  PackageOpen,
  Pencil,
  Play,
  Power,
  PowerOff,
  RotateCcw,
  RotateCw,
  ScrollText,
  Snowflake,
  StickyNote,
  TimerOff,
  User,
  Wrench,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import {
  AFTER_ACTION_TITLES,
  clockDriftSec,
  compareVersions,
  deriveDisplayStatus,
  diskLevel,
  evaluateHealth,
  formatClockDrift,
  formatGb,
  isClockDrifted,
  STEP_TITLES,
  type AlertSettings,
  type PcRecord,
  type PcRuntime,
  type RestartLauncherApp,
} from '@vade/protocol';
import type { PcAction } from '../shared/api';
import { fmtAgo, fmtBytes, fmtDateTime, fmtTime, occupancyOf, occupancyText, RESULT_LABEL } from './format';
import { useI18n } from './i18n';
import { CheckBox, Menu, StatusBadge } from './ui';

interface Props {
  pc: PcRecord;
  rt: PcRuntime | undefined;
  selected: boolean;
  runTime: string | null;
  alerts: AlertSettings;
  /** Version of the agent shipped with this admin app (older agents are highlighted) */
  latestAgentVersion: string | null;
  /** "Черга: у черзі" / "Оновлення агента: …" while a queue or rollout includes this PC */
  runState: string | null;
  onToggle: (id: number) => void;
  onAction: (action: PcAction, ids: number[]) => void;
  onLogs: (id: number) => void;
  onDiag: (id: number) => void;
  onEdit: (pc: PcRecord) => void;
  onUpdateAgent: (ids: number[]) => void;
  onToggleRepair?: (pc: PcRecord) => void;
  onEditNote?: (pc: PcRecord) => void;
  onNotify?: (pc: PcRecord) => void;
  onRestoreHz?: (pc: PcRecord) => void;
  onRestartLauncher?: (pc: PcRecord, app: RestartLauncherApp) => void;
  targetHz?: number;
}

const POWER_LABEL = { ...AFTER_ACTION_TITLES, restart: 'Перезавантаження' } as const;

function PcCardImpl({
  pc,
  rt,
  selected,
  runTime,
  alerts,
  latestAgentVersion,
  runState,
  onToggle,
  onAction,
  onLogs,
  onDiag,
  onEdit,
  onUpdateAgent,
  onToggleRepair,
  onEditNote,
  onNotify,
  onRestoreHz,
  onRestartLauncher,
  targetHz,
}: Props) {
  const { t } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const status = deriveDisplayStatus(rt);
  const occ = occupancyOf(rt);
  const online = rt?.link === 'online';
  const st = online ? rt?.status : null;
  const job = st?.job ?? null;
  const running = job?.steps.find((s) => s.status === 'running');
  const progress = job?.progress;
  const last = st?.lastJob ?? rt?.status?.lastJob ?? null;
  const wolRecent = rt?.wolSentAt && Date.now() - new Date(rt.wolSentAt).getTime() < 5 * 60_000;
  const act = (a: PcAction) => onAction(a, [pc.id]);
  const subtitle = pc.name || rt?.info?.hostname || (rt?.lastSeen ? `був онлайн ${fmtAgo(rt.lastSeen)}` : 'агент ще не підключався');
  const version = rt?.info?.version;
  const outdated = !!version && !!latestAgentVersion && compareVersions(version, latestAgentVersion) < 0;
  const health = online ? st?.health : null;
  const hwIssues = health ? evaluateHealth(health, alerts, pc.zone) : [];
  const drift = online ? clockDriftSec(st?.agentTimeMs) : null;
  const drifted = online && isClockDrifted(st?.agentTimeMs);
  const worstSsdWear = health?.ssd.reduce<number | null>((acc, d) => (d.wearPct != null && (acc == null || d.wearPct > acc) ? d.wearPct : acc), null) ?? null;

  const hasNoteText = Boolean(pc.serviceNote?.text?.trim());
  const outOfService = Boolean(pc.serviceNote?.outOfService);

  return (
    <div
      className={`card ${selected ? 'selected' : ''}${outOfService ? ' out-of-service' : ''}`}
      onClick={() => onToggle(pc.id)}
      onDoubleClick={() => onLogs(pc.id)}
    >
      <div className="card-head">
        <CheckBox state={selected ? 'on' : 'off'} />
        <span className="card-num">{pc.id}</span>
        <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
        <span className="spacer" />
        <StatusBadge status={status} />
      </div>
      <div className="card-sub-row">
        <div className="card-sub" title={subtitle}>
          {subtitle}
          {version && online ? (
            <span className={outdated ? 'ver-old' : 'dim'} title={outdated ? `Доступна версія агента ${latestAgentVersion}` : undefined}>
              {' '}
              · v{version}
            </span>
          ) : null}
          {st?.dryRun ? <span className="dim"> · dry-run</span> : null}
        </div>
        {occ && (
          <span className={`occ occ-${occ}`} title={occupancyText(rt)}>
            {occ === 'occupied' && <User size={11} strokeWidth={3} />}
            {t(`occ.${occ}`)}
          </span>
        )}
      </div>
      {(outOfService || hasNoteText) && (
        <div className="pc-service-strip" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {outOfService && (
            <span
              className="repair-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                alignSelf: 'flex-start',
                padding: '2px 7px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--occ)',
                background: 'var(--occ-soft)',
                border: '1px solid color-mix(in srgb, var(--occ) 40%, transparent)',
              }}
            >
              <Wrench size={11} />
              {tr('note.repairBadge')}
            </span>
          )}
          {hasNoteText && (
            <div
              className="note-chip"
              title={pc.serviceNote?.author ? `${pc.serviceNote.text.trim()} — ${pc.serviceNote.author}` : pc.serviceNote?.text.trim()}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 5,
                padding: '4px 7px',
                borderRadius: 6,
                fontSize: 11.5,
                color: 'var(--warn)',
                background: 'var(--warn-soft)',
                border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
                wordBreak: 'break-word',
              }}
            >
              <StickyNote size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                {pc.serviceNote?.text.trim()}
                {pc.serviceNote?.author ? <span className="dim"> · {pc.serviceNote.author}</span> : null}
              </span>
            </div>
          )}
        </div>
      )}
      <dl className="kv">
        <dt>IP</dt>
        <dd>{pc.ip}</dd>
        <dt>MAC</dt>
        <dd>{pc.mac}</dd>
      </dl>
      {online && st?.disks && st.disks.length > 0 && (
        <div className="disks">
          {st.disks.map((d) => (
            <span
              key={d.drive}
              className={`disk ${diskLevel(d.freeBytes, alerts)}`}
              title={`${d.drive} вільно ${formatGb(d.freeBytes)} з ${formatGb(d.totalBytes)}`}
            >
              {d.drive} {formatGb(d.freeBytes)}
            </span>
          ))}
        </div>
      )}
      {online && health && (
        <div className="hw-chips">
          <span className={`hw-chip ${hwIssues.find((i) => i.kind === 'ram')?.level ?? ''}`} title="Оперативна пам'ять">
            {health.ramTotalGb} ГБ
          </span>
          {health.refreshRateHz != null && (
            <span className={`hw-chip ${hwIssues.find((i) => i.kind === 'refreshRate')?.level ?? ''}`} title="Частота оновлення монітора">
              {health.refreshRateHz} Гц
            </span>
          )}
          {health.gpuTempC != null && (
            <span className={`hw-chip ${hwIssues.find((i) => i.kind === 'gpuTemp')?.level ?? ''}`} title="Температура GPU">
              GPU {health.gpuTempC}°C
            </span>
          )}
          {worstSsdWear != null && (
            <span className={`hw-chip ${hwIssues.find((i) => i.kind === 'ssdWear' || i.kind === 'ssdHealth')?.level ?? ''}`} title="Максимальний знос SSD">
              SSD {worstSsdWear}%
            </span>
          )}
        </div>
      )}
      <div className="card-info">
        {job ? (
          <>
            <div className="row">
              {running ? STEP_TITLES[running.id] : 'Обслуговування'}
              {progress && (
                <span className="dim">
                  · {progress.appId} {progress.pct.toFixed(0)}%
                </span>
              )}
            </div>
            <div className={`progress ${progress ? '' : 'indeterminate'}`}>
              <i style={{ width: `${progress?.pct ?? 0}%` }} />
            </div>
            {progress && progress.totalBytes > 0 && (
              <div className="dim">
                {progress.phase} {fmtBytes(progress.doneBytes)} / {fmtBytes(progress.totalBytes)}
              </div>
            )}
          </>
        ) : st?.state === 'steam-login' ? (
          <div className="row">Вхід SteamCMD…</div>
        ) : (
          <>
            {st?.pendingPower && (
              <div className="row warn">
                <TimerOff size={13} /> {POWER_LABEL[st.pendingPower.action]} о {fmtTime(st.pendingPower.at)}
              </div>
            )}
            {st?.quickCleanAt && (
              <div className="row warn">
                <LogOut size={13} /> Очищення логінів о {new Date(st.quickCleanAt).toLocaleTimeString('uk-UA')}
              </div>
            )}
            {last && (
              <div className={`row ${last.result === 'errors' ? 'err' : ''}`}>
                Останнє: {last.result ? RESULT_LABEL[last.result] : '—'} · {fmtDateTime(last.finishedAt ?? last.startedAt)}
              </div>
            )}
            <div className="row dim">{runTime ? `Розклад: ${runTime}` : 'Не в нічному розкладі'}</div>
            {!online && wolRecent && <div className="row dim">WoL надіслано о {fmtTime(rt!.wolSentAt)}</div>}
            {drifted && drift != null && (
              <div className="row warn">
                <Clock size={13} /> Збитий час ({formatClockDrift(drift)})
              </div>
            )}
            {(rt?.link === 'auth-failed' || rt?.link === 'incompatible') && rt.lastError && <div className="row err">{rt.lastError}</div>}
          </>
        )}
        {runState && <div className="row" style={{ color: 'var(--accent)' }}>{runState}</div>}
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={t('action.wake')} onClick={() => act('wake')}>
          <Power size={15} />
        </button>
        <button className="icon-btn" title={t('action.test')} disabled={!online || !!job} onClick={() => act('test')}>
          <Play size={15} />
        </button>
        <button className="icon-btn" title={t('action.cleanLogins')} disabled={!online || !!job} onClick={() => act('clean-logins')}>
          <LogOut size={15} />
        </button>
        <button className="icon-btn" data-keep-drawer="true" title={t('pcs.liveLog')} onClick={() => onLogs(pc.id)}>
          <ScrollText size={15} />
        </button>
        <button className="icon-btn" title={t('pcs.editPc')} onClick={() => onEdit(pc)}>
          <Pencil size={15} />
        </button>
        <span className="spacer" />
        <Menu
          trigger={(toggle) => (
            <button className="icon-btn" title="Інші дії" onClick={toggle}>
              <Ellipsis size={15} />
            </button>
          )}
        >
          {(close) => {
            const item = (a: PcAction, label: string, icon: ReactNode, danger = false) => (
              <button
                className={danger ? 'danger' : ''}
                disabled={!online}
                style={!online ? { opacity: 0.4 } : undefined}
                onClick={() => {
                  close();
                  if (online) act(a);
                }}
              >
                {icon} {label}
              </button>
            );
            const fnItem = (label: string, icon: ReactNode, fn: () => void, requireOnline = true) => {
              const disabled = requireOnline && !online;
              return (
                <button
                  disabled={disabled}
                  style={disabled ? { opacity: 0.4 } : undefined}
                  onClick={() => {
                    close();
                    if (!disabled) fn();
                  }}
                >
                  {icon} {label}
                </button>
              );
            };
            return (
              <>
                {item('sleep', t('action.sleep'), <Moon size={15} />)}
                {item('hibernate', t('action.hibernate'), <Snowflake size={15} />)}
                {item('shutdown', t('action.shutdown'), <PowerOff size={15} />, true)}
                {item('restart', t('action.restart'), <RotateCcw size={15} />, true)}
                <hr />
                {item('cancel', t('action.cancel'), <CircleStop size={15} />)}
                {item('cancel-power', t('action.cancelPower'), <TimerOff size={15} />)}
                {item('sync-time', t('action.syncTime'), <Clock size={15} />)}
                {fnItem(t('pcs.quickDiag'), <Activity size={15} />, () => onDiag(pc.id))}
                {(onNotify || onRestoreHz || onRestartLauncher) && (
                  <>
                    <hr />
                    {onNotify && fnItem(tr('diag.notifyAction'), <MessageSquare size={15} />, () => onNotify(pc))}
                    {onRestoreHz && fnItem(tr('diag.restoreHzAction', { hz: targetHz ?? 240 }), <Monitor size={15} />, () => onRestoreHz(pc))}
                    {onRestartLauncher && fnItem(tr('diag.restartSteam'), <RotateCw size={15} />, () => onRestartLauncher(pc, 'steam'))}
                    {onRestartLauncher && fnItem(tr('diag.restartRiot'), <RotateCw size={15} />, () => onRestartLauncher(pc, 'riot'))}
                  </>
                )}
                {(onToggleRepair || onEditNote) && (
                  <>
                    <hr />
                    {onToggleRepair &&
                      fnItem(outOfService ? tr('note.clearRepair') : tr('note.markRepair'), <Wrench size={15} />, () => onToggleRepair(pc), false)}
                    {onEditNote && fnItem(pc.serviceNote ? tr('note.editNote') : tr('note.addNote'), <StickyNote size={15} />, () => onEditNote(pc), false)}
                  </>
                )}
                <hr />
                {fnItem(t('pcs.updateAgentAction'), <PackageOpen size={15} />, () => onUpdateAgent([pc.id]))}
              </>
            );
          }}
        </Menu>
      </div>
    </div>
  );
}

export const PcCard = memo(PcCardImpl);
