import { CircleStop, Clock, Ellipsis, LogOut, Moon, PackageOpen, Pencil, Play, Power, PowerOff, RotateCcw, ScrollText, Snowflake, TimerOff, User } from 'lucide-react';
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
  OCCUPANCY_TITLES,
  STEP_TITLES,
  type AlertSettings,
  type PcRecord,
  type PcRuntime,
} from '@vade/protocol';
import type { PcAction } from '../shared/api';
import { fmtAgo, fmtBytes, fmtDateTime, fmtTime, occupancyOf, occupancyText, RESULT_LABEL } from './format';
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
  onEdit: (pc: PcRecord) => void;
  onUpdateAgent: (ids: number[]) => void;
}

const POWER_LABEL = { ...AFTER_ACTION_TITLES, restart: 'Перезавантаження' } as const;

function PcCardImpl({ pc, rt, selected, runTime, alerts, latestAgentVersion, runState, onToggle, onAction, onLogs, onEdit, onUpdateAgent }: Props) {
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

  return (
    <div className={`card ${selected ? 'selected' : ''}`} onClick={() => onToggle(pc.id)} onDoubleClick={() => onLogs(pc.id)}>
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
            {OCCUPANCY_TITLES[occ]}
          </span>
        )}
      </div>
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
        <button className="icon-btn" title="Увімкнути (Wake-on-LAN)" onClick={() => act('wake')}>
          <Power size={15} />
        </button>
        <button className="icon-btn" title="Обслуговування зараз (без вимкнення)" disabled={!online || !!job} onClick={() => act('test')}>
          <Play size={15} />
        </button>
        <button className="icon-btn" title="Очистити логіни зараз (Steam, браузери)" disabled={!online || !!job} onClick={() => act('clean-logins')}>
          <LogOut size={15} />
        </button>
        <button className="icon-btn" title="Живий лог" onClick={() => onLogs(pc.id)}>
          <ScrollText size={15} />
        </button>
        <button className="icon-btn" title="Редагувати ПК" onClick={() => onEdit(pc)}>
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
            return (
              <>
                {item('sleep', 'Сон', <Moon size={15} />)}
                {item('hibernate', 'Гібернація', <Snowflake size={15} />)}
                {item('shutdown', 'Вимкнути', <PowerOff size={15} />, true)}
                {item('restart', 'Перезавантажити', <RotateCcw size={15} />, true)}
                <hr />
                {item('cancel', 'Скасувати завдання', <CircleStop size={15} />)}
                {item('cancel-power', 'Скасувати вимкнення', <TimerOff size={15} />)}
                {item('sync-time', 'Синхронізувати час', <Clock size={15} />)}
                <hr />
                <button
                  disabled={!online}
                  style={!online ? { opacity: 0.4 } : undefined}
                  onClick={() => {
                    close();
                    if (online) onUpdateAgent([pc.id]);
                  }}
                >
                  <PackageOpen size={15} /> Оновити агент…
                </button>
              </>
            );
          }}
        </Menu>
      </div>
    </div>
  );
}

export const PcCard = memo(PcCardImpl);
