import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  LoaderCircle,
  Monitor,
  Moon,
  Power,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Sun,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  evaluateHealth,
  isPcScheduled,
  resolveHealthThresholds,
  worstDiskLevel,
  type AppSettings,
  type PcRecord,
  type PcRuntime,
} from '@vade/protocol';
import type { ActionResult } from '../shared/api';
import { api, errorText } from './api';
import { occupancyOf, zonesOf } from './format';
import { useI18n } from './i18n';
import { Modal, Segmented, useToast } from './ui';

interface Props {
  mode: 'open' | 'close';
  pcs: PcRecord[];
  runtimes: Record<number, PcRuntime>;
  settings: AppSettings;
  onClose: () => void;
}

const WAKE_TIMEOUT_MS = 120_000;

export function ShiftMacroModal({ mode, pcs, runtimes, settings, onClose }: Props) {
  return mode === 'open' ? (
    <OpenHallModal pcs={pcs} runtimes={runtimes} settings={settings} onClose={onClose} />
  ) : (
    <CloseHallModal pcs={pcs} runtimes={runtimes} settings={settings} onClose={onClose} />
  );
}

function OpenHallModal({
  pcs,
  runtimes,
  settings,
  onClose,
}: Omit<Props, 'mode'>) {
  const { t } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const toast = useToast();

  const zones = useMemo(() => {
    const present = new Set(pcs.map((p) => p.zone));
    return zonesOf(pcs).filter((z) => present.has(z));
  }, [pcs]);

  const [zone, setZone] = useState('all');
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deadlineMs, setDeadlineMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const sortedPcs = useMemo(() => [...pcs].sort((a, b) => a.id - b.id), [pcs]);
  const scopedPcs = useMemo(
    () => (zone === 'all' ? sortedPcs : sortedPcs.filter((p) => p.zone === zone)),
    [sortedPcs, zone],
  );

  const { skippedRepair, activePcs, alreadyOnline, toWake } = useMemo(() => {
    const repair: PcRecord[] = [];
    const active: PcRecord[] = [];
    const online: PcRecord[] = [];
    const wake: PcRecord[] = [];
    for (const pc of scopedPcs) {
      if (pc.serviceNote?.outOfService) {
        repair.push(pc);
        continue;
      }
      active.push(pc);
      if (runtimes[pc.id]?.link === 'online') online.push(pc);
      else wake.push(pc);
    }
    return { skippedRepair: repair, activePcs: active, alreadyOnline: online, toWake: wake };
  }, [scopedPcs, runtimes]);

  useEffect(() => {
    if (!started || deadlineMs == null) return;
    setNowMs(Date.now());
    const id = setInterval(() => {
      const cur = Date.now();
      setNowMs(cur);
      if (cur >= deadlineMs) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, [started, deadlineMs]);

  const remainingSec = deadlineMs == null ? 0 : Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const timedOut = started && remainingSec === 0;
  const onlineCount = alreadyOnline.length;
  const totalCount = activePcs.length;
  const progressPct = totalCount > 0 ? Math.round((onlineCount / totalCount) * 100) : 100;

  const lowHzRows = useMemo(() => {
    return alreadyOnline
      .map((pc) => {
        const rt = runtimes[pc.id];
        const health = rt?.status?.health;
        const issues = evaluateHealth(health, settings.alerts, pc.zone);
        if (!issues.some((i) => i.kind === 'refreshRate')) return null;
        const targetHz = resolveHealthThresholds(settings.alerts, pc.zone).minRefreshRateHz || 240;
        return { pc, actualHz: health?.refreshRateHz ?? 0, targetHz };
      })
      .filter((x): x is { pc: PcRecord; actualHz: number; targetHz: number } => x !== null);
  }, [alreadyOnline, runtimes, settings.alerts]);

  const issueRows = useMemo(() => {
    return scopedPcs
      .map((pc) => {
        const rt = runtimes[pc.id];
        const online = rt?.link === 'online';
        const items: Array<{ text: string; level: 'warn' | 'crit' | 'note' }> = [];

        if (rt?.link === 'auth-failed' || rt?.link === 'incompatible') {
          items.push({ text: rt.lastError || tr('shift.linkError'), level: 'crit' });
        }
        if (online && rt?.status?.lastJob?.result === 'errors') {
          items.push({ text: tr('shift.lastJobError'), level: 'crit' });
        }
        if (online && worstDiskLevel(rt?.status?.disks, settings.alerts) === 'crit') {
          items.push({ text: tr('shift.diskCritAlert'), level: 'crit' });
        }
        if (online) {
          for (const hi of evaluateHealth(rt?.status?.health, settings.alerts, pc.zone)) {
            if (hi.kind === 'refreshRate') continue;
            items.push({ text: hi.message, level: hi.level });
          }
        }
        if (pc.serviceNote?.outOfService) {
          items.push({ text: tr('shift.repairBadge'), level: 'warn' });
        }
        if (pc.serviceNote?.text?.trim()) {
          items.push({ text: pc.serviceNote.text.trim(), level: 'note' });
        }
        if (items.length === 0) return null;
        return { pc, items };
      })
      .filter((x): x is { pc: PcRecord; items: Array<{ text: string; level: 'warn' | 'crit' | 'note' }> } => x !== null);
  }, [scopedPcs, runtimes, settings.alerts]);

  const startOpening = async () => {
    if (starting || activePcs.length === 0) return;
    const wakeIds = toWake.map((p) => p.id);
    setStarting(true);
    try {
      if (wakeIds.length > 0) {
        await api.runAction('wake', wakeIds);
      }
      void api
        .recordAudit(
          'shift.open',
          (wakeIds.length > 0 ? wakeIds : activePcs.map((p) => p.id)).map(String),
          zone,
        )
        .catch(() => undefined);
      setDeadlineMs(wakeIds.length > 0 ? Date.now() + WAKE_TIMEOUT_MS : Date.now());
      setNowMs(Date.now());
      setStarted(true);
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const retryWake = async (pcId: number) => {
    if (retryingId !== null) return;
    setRetryingId(pcId);
    try {
      const res = await api.runAction('wake', [pcId]);
      const first = res[0];
      toast(first?.ok ? 'ok' : 'warn', first?.message || t('common.pcNum', { id: pcId }));
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setRetryingId(null);
    }
  };

  const restoreHz = async (pcId: number, targetHz: number) => {
    if (restoringId !== null) return;
    setRestoringId(pcId);
    try {
      const res = await api.diagRestoreRefreshRate(pcId, targetHz);
      if (res.ok) {
        void api.recordAudit('diag.restore_hz', [String(pcId)], `${targetHz} Hz`).catch(() => undefined);
      }
      toast(res.ok ? 'ok' : 'warn', res.message);
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <Modal
      wide
      title={tr('shift.openTitle')}
      icon={<Sun size={18} color="var(--warn)" />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          {!started && (
            <button
              type="button"
              className="btn primary"
              disabled={starting || activePcs.length === 0}
              onClick={() => void startOpening()}
            >
              {starting ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />}
              {toWake.length > 0 ? tr('shift.startOpen') : tr('shift.checkOnlineOnly')}
            </button>
          )}
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {tr('shift.openDesc')}
      </p>

      <div className="toolbar-row" style={{ marginBottom: 12 }}>
        {!started ? (
          <Segmented
            value={zone}
            onChange={setZone}
            options={[
              { value: 'all', label: `${t('pcs.all')} (${pcs.length})` },
              ...zones.map((z) => ({
                value: z,
                label: `${z} (${pcs.filter((p) => p.zone === z).length})`,
              })),
            ]}
          />
        ) : (
          <span className="tag">{zone === 'all' ? t('pcs.all') : zone}</span>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipToWake', { count: toWake.length })}
        </span>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--ok-soft)',
            color: 'var(--ok)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipAlreadyOnline', { count: alreadyOnline.length })}
        </span>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipSkippedRepair', { count: skippedRepair.length })}
        </span>
      </div>

      {started && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 600 }}>
                {tr('shift.onlineProgress', { online: onlineCount, total: totalCount })}
              </span>
              <span className="spacer" />
              {onlineCount === totalCount ? (
                <span className="result-chip" style={{ color: 'var(--ok)', fontSize: 12.5 }}>
                  <CheckCircle2 size={15} />
                  {tr('shift.allOnlineDone', { count: totalCount })}
                </span>
              ) : remainingSec > 0 ? (
                <span className="result-chip" style={{ color: 'var(--accent)', fontSize: 12.5 }}>
                  <Clock size={14} />
                  {tr('shift.countdown', { sec: remainingSec })}
                </span>
              ) : (
                <span className="result-chip" style={{ color: 'var(--warn)', fontSize: 12.5 }}>
                  <AlertTriangle size={14} />
                  {tr('shift.wakeTimeoutBanner', { count: toWake.length })}
                </span>
              )}
            </div>
            <div className={`meter ${timedOut && toWake.length > 0 ? 'warn' : ''}`}>
              <i
                style={{
                  width: `${progressPct}%`,
                  background: onlineCount === totalCount ? 'var(--ok)' : timedOut ? 'var(--warn)' : 'var(--accent)',
                }}
              />
            </div>
          </div>

          {toWake.length > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Power size={15} color={timedOut ? 'var(--warn)' : 'var(--accent)'} />
                {tr('shift.notWokenTitle', { count: toWake.length })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {toWake.map((pc) => (
                  <div
                    key={pc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <strong>{t('common.pcNum', { id: pc.id })}</strong>
                    <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
                    <span className="mono dim">{pc.ip}</span>
                    <span className="spacer" />
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: timedOut ? 'var(--err)' : 'var(--text-3)',
                      }}
                    >
                      {timedOut ? tr('shift.timedOutStatus') : tr('shift.waitingStatus')}
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      disabled={retryingId === pc.id}
                      onClick={() => void retryWake(pc.id)}
                    >
                      {retryingId === pc.id ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
                      {tr('shift.retryWol')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lowHzRows.length > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--warn-soft)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 7, color: 'var(--warn)' }}>
                <Monitor size={15} />
                {tr('shift.lowHzTitle', { count: lowHzRows.length })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {lowHzRows.map(({ pc, actualHz, targetHz }) => (
                  <div
                    key={pc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <strong>{t('common.pcNum', { id: pc.id })}</strong>
                    <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
                    <span className="mono" style={{ color: 'var(--warn)', fontWeight: 600 }}>
                      {tr('shift.hzActualVsTarget', { actual: actualHz, target: targetHz })}
                    </span>
                    <span className="spacer" />
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={restoringId === pc.id}
                      onClick={() => void restoreHz(pc.id, targetHz)}
                    >
                      {restoringId === pc.id ? <LoaderCircle size={13} className="spin" /> : <Monitor size={13} />}
                      {tr('shift.restoreHzBtn', { hz: targetHz })}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {issueRows.length > 0 ? (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 7 }}>
                <Wrench size={15} color="var(--warn)" />
                {tr('shift.issuesTitle', { count: issueRows.length })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {issueRows.map(({ pc, items }) => (
                  <div
                    key={pc.id}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: 'var(--bg-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <strong>{t('common.pcNum', { id: pc.id })}</strong>
                    <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
                    {items.map((item, idx) => (
                      <span
                        key={idx}
                        className="tag"
                        style={
                          item.level === 'crit'
                            ? { background: 'var(--err-soft)', color: 'var(--err)' }
                            : item.level === 'warn'
                              ? { background: 'var(--warn-soft)', color: 'var(--warn)' }
                              : undefined
                        }
                      >
                        {item.text}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            lowHzRows.length === 0 && (
              <div className="notice" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
                <CheckCircle2 size={16} />
                <span>{tr('shift.checklistClean')}</span>
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  );
}

function CloseHallModal({
  pcs,
  runtimes,
  settings,
  onClose,
}: Omit<Props, 'mode'>) {
  const { t } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const toast = useToast();

  const [cleaning, setCleaning] = useState(false);
  const [results, setResults] = useState<ActionResult[] | null>(null);

  const sortedPcs = useMemo(() => [...pcs].sort((a, b) => a.id - b.id), [pcs]);

  const { freeOnline, occupied, offline } = useMemo(() => {
    const free: PcRecord[] = [];
    const occ: PcRecord[] = [];
    const off: PcRecord[] = [];
    for (const pc of sortedPcs) {
      const rt = runtimes[pc.id];
      if (rt?.link !== 'online') {
        off.push(pc);
      } else if (occupancyOf(rt) === 'free') {
        free.push(pc);
      } else {
        occ.push(pc);
      }
    }
    return { freeOnline: free, occupied: occ, offline: off };
  }, [sortedPcs, runtimes]);

  const scheduledCount = useMemo(
    () => pcs.filter((pc) => isPcScheduled(settings, pc)).length,
    [pcs, settings],
  );

  const runCloseClean = async () => {
    if (cleaning || freeOnline.length === 0) return;
    const ids = freeOnline.map((p) => p.id);
    setCleaning(true);
    try {
      const res = await api.runAction('clean-logins', ids);
      setResults(res);
      const okCount = res.filter((r) => r.ok).length;
      const errCount = res.length - okCount;
      void api
        .recordAudit('shift.close', ids.map(String), `ok=${okCount}, err=${errCount}`)
        .catch(() => undefined);
      toast(errCount === 0 ? 'ok' : okCount > 0 ? 'warn' : 'error', tr('shift.cleanSummary', { ok: okCount, err: errCount }));
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setCleaning(false);
    }
  };

  const okTotal = results ? results.filter((r) => r.ok).length : 0;
  const errTotal = results ? results.length - okTotal : 0;

  return (
    <Modal
      wide
      title={tr('shift.closeTitle')}
      icon={<Moon size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={cleaning}>
            {t('common.close')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={cleaning || freeOnline.length === 0}
            onClick={() => void runCloseClean()}
          >
            {cleaning ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
            {cleaning ? tr('shift.cleaning') : tr('shift.cleanFreeBtn', { count: freeOnline.length })}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {tr('shift.closeDesc')}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--ok-soft)',
            color: 'var(--ok)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipFreeOnline', { count: freeOnline.length })}
        </span>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--occ-soft)',
            color: 'var(--occ)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipOccupiedSkip', { count: occupied.length })}
        </span>
        <span
          className="result-chip"
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--off-soft)',
            color: 'var(--text-2)',
            fontSize: 12,
          }}
        >
          {tr('shift.chipOffline', { count: offline.length })}
        </span>
      </div>

      {occupied.length > 0 && (
        <div
          className="notice"
          style={{
            marginBottom: 12,
            background: 'var(--occ-soft)',
            color: 'var(--occ)',
          }}
        >
          <ShieldAlert size={16} />
          <span>{tr('shift.occupiedNote', { list: occupied.map((p) => `#${p.id}`).join(', ') })}</span>
        </div>
      )}

      <div
        className={`notice ${settings.schedule.enabled ? '' : 'warn'}`}
        style={
          settings.schedule.enabled
            ? { marginBottom: 14, background: 'var(--ok-soft)', color: 'var(--ok)' }
            : { marginBottom: 14, color: 'var(--warn)' }
        }
      >
        {settings.schedule.enabled ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        <span>
          {settings.schedule.enabled
            ? tr('shift.scheduleOn', {
                time: settings.schedule.startTime,
                mode: settings.schedule.mode,
                count: scheduledCount,
              })
            : tr('shift.scheduleOff')}
        </span>
      </div>

      {results && (
        <div className="deploy-results">
          <div className="deploy-summary">
            <strong>{tr('shift.cleanSummary', { ok: okTotal, err: errTotal })}</strong>
          </div>
          <div className="plan-wrap" style={{ maxHeight: 260 }}>
            <table className="scan">
              <tbody>
                {results.map((r) => (
                  <tr key={r.pcId}>
                    <td style={{ width: 90 }}>
                      <strong>{t('common.pcNum', { id: r.pcId })}</strong>
                    </td>
                    <td style={{ width: 70 }}>
                      <span
                        className="tag"
                        style={
                          r.ok
                            ? { background: 'var(--ok-soft)', color: 'var(--ok)' }
                            : { background: 'var(--err-soft)', color: 'var(--err)' }
                        }
                      >
                        {r.ok ? 'OK' : 'ERR'}
                      </span>
                    </td>
                    <td className="dim">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
