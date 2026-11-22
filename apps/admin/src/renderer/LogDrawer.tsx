import { Ban, CircleCheck, CircleDashed, CircleStop, CircleX, Copy, LoaderCircle, Lock, Play, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import {
  deriveDisplayStatus,
  diskLevel,
  formatGb,
  OCCUPANCY_TITLES,
  STEP_TITLES,
  type AppSettings,
  type PcRecord,
  type PcRuntime,
  type StepStatus,
} from '@vade/protocol';
import type { PcAction, UiLogLine } from '../shared/api';
import { api, errorText } from './api';
import { APP_STATUS, fmtDateTime, occupancyOf, occupancyText, RESULT_LABEL, STEP_ICON_CLASS } from './format';
import { ConfirmDialog, StatusBadge, Switch, useToast } from './ui';

const STEP_ICON: Record<StepStatus, ReactElement> = {
  pending: <CircleDashed size={15} />,
  running: <LoaderCircle size={15} className="spin" />,
  ok: <CircleCheck size={15} />,
  skipped: <CircleDashed size={15} />,
  error: <CircleX size={15} />,
};

interface Props {
  pc: PcRecord;
  rt: PcRuntime | undefined;
  settings: AppSettings;
  onSettingsSaved: (s: AppSettings) => void;
  onClose: () => void;
  onAction: (action: PcAction, ids: number[]) => void;
}

function timeOf(ts: string): string {
  return new Date(ts).toLocaleTimeString('uk-UA');
}

export function LogDrawer({ pc, rt, settings, onSettingsSaved, onClose, onAction }: Props) {
  const toast = useToast();
  const [lines, setLines] = useState<UiLogLine[]>([]);
  const [showSteam, setShowSteam] = useState(true);
  const [follow, setFollow] = useState(true);
  const [confirmSenet, setConfirmSenet] = useState(false);
  const [ignoringApp, setIgnoringApp] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLines([]);
    void api.getLogs(pc.id).then((l) => alive && setLines(l));
    const off = api.onLogs((batches) => {
      const mine = batches.filter((b) => b.pcId === pc.id).flatMap((b) => b.lines);
      if (mine.length) setLines((prev) => [...prev, ...mine].slice(-2000));
    });
    return () => {
      alive = false;
      off();
    };
  }, [pc.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = showSteam ? lines : lines.filter((l) => l.level !== 'steam');
  useLayoutEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [shown.length, follow]);

  const online = rt?.link === 'online';
  const job = rt?.status?.job ?? null;
  const shownJob = job ?? rt?.status?.lastJob ?? null;

  const occ = occupancyOf(rt);
  const presence = online ? rt?.status?.presence : null;

  /** Teaches the detector what the SENET login screen looks like, from what is on this PC right now. */
  const markSenetLock = async () => {
    if (!presence?.foreground) return;
    const next = structuredClone(settings);
    const d = next.detector;
    const add = (list: string[], v: string) => (v && !list.some((x) => x.toLowerCase() === v.toLowerCase()) ? [...list, v] : list);
    d.senetProcesses = add(d.senetProcesses, presence.foreground);
    d.senetLockTitles = add(d.senetLockTitles, presence.foregroundTitle.trim());
    try {
      onSettingsSaved(await api.saveSettings(next));
      toast('ok', `Збережено: процес SENET ${presence.foreground}${presence.foregroundTitle.trim() ? `, заголовок «${presence.foregroundTitle.trim()}»` : ''}`);
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const addToIgnore = async (appId: number, name?: string) => {
    if (settings.maintenance.update.ignoreAppIds.includes(appId)) return;
    setIgnoringApp(appId);
    try {
      const next = structuredClone(settings);
      next.maintenance.update.ignoreAppIds = [...next.maintenance.update.ignoreAppIds, appId];
      onSettingsSaved(await api.saveSettings(next));
      toast('ok', `AppID ${appId}${name ? ` (${name})` : ''} додано до списку ігнорування — налаштування надіслано агентам`);
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setIgnoringApp(null);
    }
  };

  const copy = async () => {
    const text = shown.map((l) => `[${new Date(l.ts).toLocaleString('uk-UA')}] ${l.level.toUpperCase()} ${l.msg}`).join('\n');
    await navigator.clipboard.writeText(text);
    toast('ok', `Скопійовано ${shown.length} рядків`);
  };

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <h2>ПК №{pc.id}</h2>
        <StatusBadge status={deriveDisplayStatus(rt)} />
        <span className="host" title={rt?.info?.hostname ?? pc.ip}>
          {rt?.info?.hostname ?? pc.ip}
        </span>
        <span className="spacer" />
        <button className="btn small" disabled={!online || !!job} onClick={() => onAction('test', [pc.id])}>
          <Play size={14} /> Обслуговування
        </button>
        <button className="btn small" disabled={!job} onClick={() => onAction('cancel', [pc.id])}>
          <CircleStop size={14} /> Скасувати
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Закрити">
          <X size={16} />
        </button>
      </div>
      <div className="drawer-body">
        {occ && (
          <div className="occ-box">
            <div className="row">
              <span className={`occ occ-${occ}`}>{OCCUPANCY_TITLES[occ]}</span>
              <span>{occupancyText(rt)}</span>
            </div>
            {presence && (
              <div className="row dim" style={{ fontSize: 12 }}>
                {presence.locked && (
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <Lock size={12} /> Windows заблоковано ·
                  </span>
                )}
                <span>
                  Активне вікно: <span className="mono">{presence.foreground || '—'}</span>
                  {presence.foregroundTitle ? ` «${presence.foregroundTitle}»` : ''}
                </span>
                {presence.foreground && !settings.detector.senetProcesses.some((s) => s.toLowerCase() === presence.foreground.toLowerCase()) && (
                  <button className="btn small ghost" title="Додати цей процес і заголовок у налаштування SENET" onClick={() => setConfirmSenet(true)}>
                    Це екран входу SENET
                  </button>
                )}
              </div>
            )}
            {online && rt?.status?.disks && rt.status.disks.length > 0 && (
              <div className="row" style={{ fontSize: 12 }}>
                <span className="dim">Диски:</span>
                <span className="disks">
                  {rt.status.disks.map((d) => (
                    <span key={d.drive} className={`disk ${diskLevel(d.freeBytes, settings.alerts)}`}>
                      {d.drive} {formatGb(d.freeBytes)} з {formatGb(d.totalBytes)}
                    </span>
                  ))}
                </span>
              </div>
            )}
            {rt?.status?.lastQuickClean && (
              <div className="row dim" style={{ fontSize: 12 }}>
                Останнє очищення логінів ({rt.status.lastQuickClean.trigger === 'auto' ? 'авто' : 'вручну'}, {fmtDateTime(rt.status.lastQuickClean.at)}):{' '}
                {rt.status.lastQuickClean.summary}
              </div>
            )}
          </div>
        )}
        {shownJob && (
          <div className="job-box">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{job ? 'Поточне завдання' : 'Останнє завдання'}</strong>
              <span className="dim" style={{ fontSize: 12 }}>
                {fmtDateTime(shownJob.startedAt)}
                {shownJob.finishedAt ? ` → ${fmtDateTime(shownJob.finishedAt)}` : ''}
              </span>
              <span className="spacer" />
              {shownJob.result && <span className={shownJob.result === 'ok' ? 's-ok' : 's-error'}>{RESULT_LABEL[shownJob.result]}</span>}
            </div>
            <ul className="steps">
              {shownJob.steps.map((s) => (
                <li key={s.id} className={STEP_ICON_CLASS[s.status]}>
                  {STEP_ICON[s.status]}
                  <span style={{ color: 'var(--text)' }}>{STEP_TITLES[s.id]}</span>
                  {s.note && <span className="note">{s.note}</span>}
                </li>
              ))}
            </ul>
            {shownJob.progress && (
              <div style={{ marginTop: 10 }}>
                <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
                  {shownJob.progress.appId}: {shownJob.progress.phase} {shownJob.progress.pct.toFixed(1)}%
                </div>
                <div className="progress">
                  <i style={{ width: `${shownJob.progress.pct}%` }} />
                </div>
              </div>
            )}
            {shownJob.apps.length > 0 && (
              <table className="apps">
                <thead>
                  <tr>
                    <th>AppID</th>
                    <th>Гра</th>
                    <th>Статус</th>
                    <th>Бібліотека</th>
                  </tr>
                </thead>
                <tbody>
                  {shownJob.apps.map((a) => {
                    const canIgnore = a.status === 'error' || a.status === 'skipped_no_subscription';
                    const alreadyIgnored = settings.maintenance.update.ignoreAppIds.includes(a.appId);
                    return (
                      <tr key={`${a.library}:${a.appId}`}>
                        <td className="mono">{a.appId}</td>
                        <td>{a.name ?? '—'}</td>
                        <td className={APP_STATUS[a.status].cls} title={a.message}>
                          <div className="app-status-row">
                            <span>{APP_STATUS[a.status].label}</span>
                            {canIgnore &&
                              (alreadyIgnored ? (
                                <span className="ignore-tag">в ігнорі</span>
                              ) : (
                                <button
                                  type="button"
                                  className="ignore-btn"
                                  disabled={ignoringApp === a.appId}
                                  title={`Додати AppID ${a.appId} у список ігнорування`}
                                  onClick={() => void addToIgnore(a.appId, a.name)}
                                >
                                  <Ban size={11} /> + в ігнор
                                </button>
                              ))}
                          </div>
                          {a.message && a.status !== 'ok' && <div className="dim">{a.message}</div>}
                        </td>
                        <td className="dim mono">{a.library}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
        <div className="log-tools">
          <strong>Лог</strong>
          <span className="dim">{shown.length}</span>
          <span className="spacer" />
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Switch on={showSteam} onChange={setShowSteam} label="Вивід SteamCMD" /> SteamCMD
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Switch on={follow} onChange={setFollow} label="Автопрокрутка" /> Автопрокрутка
          </label>
          <button className="icon-btn" title="Копіювати лог" onClick={() => void copy()}>
            <Copy size={14} />
          </button>
        </div>
        <div className="log" ref={logRef}>
          {shown.length === 0 && <div className="dim">Поки що порожньо. Лог з'явиться, коли агент підключиться.</div>}
          {shown.map((l, i) => (
            <div key={i} className={l.admin ? 'l-admin' : `l-${l.level}`}>
              <span className="ts">{timeOf(l.ts)}</span>
              {l.admin ? '[адмін] ' : ''}
              {l.msg}
            </div>
          ))}
        </div>
      </div>
      {confirmSenet && presence && (
        <ConfirmDialog
          title="Позначити як екран входу SENET?"
          text={
            <>
              <p style={{ marginTop: 0 }}>
                Процес <span className="mono">{presence.foreground}</span>
                {presence.foregroundTitle.trim() ? (
                  <>
                    {' '}
                    і заголовок «{presence.foregroundTitle.trim()}»
                  </>
                ) : null}{' '}
                буде додано в налаштування детектора для всіх ПК.
              </p>
              <p>
                Робіть це, лише коли на цьому ПК зараз показано екран входу SENET. Інакше ПК із цією програмою завжди вважатимуться
                зайнятими. Виправити можна на вкладці «Розклад і завдання».
              </p>
            </>
          }
          confirmLabel="Так, це екран входу SENET"
          onConfirm={() => void markSenetLock()}
          onClose={() => setConfirmSenet(false)}
        />
      )}
    </aside>
  );
}
