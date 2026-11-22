import { Activity, Camera, Download, FolderSync, LoaderCircle, Search, Skull } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiagProcess, DiagScreenshotResult, PcRecord, PcRuntime } from '@vade/protocol';
import { api, errorText } from './api';
import { useI18n } from './i18n';
import { ConfirmDialog, Modal, useToast } from './ui';

interface Props {
  pc: PcRecord;
  rt: PcRuntime | undefined;
  onClose: () => void;
}

export function DiagDialog({ pc, rt, onClose }: Props) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [procs, setProcs] = useState<DiagProcess[]>([]);
  const [loadingProcs, setLoadingProcs] = useState(false);
  const [procError, setProcError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [confirmKill, setConfirmKill] = useState<DiagProcess | null>(null);
  const [restartingExp, setRestartingExp] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [screen, setScreen] = useState<DiagScreenshotResult | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);

  const online = rt?.link === 'online';

  const loadProcesses = useCallback(async () => {
    setLoadingProcs(true);
    setProcError(null);
    try {
      setProcs(await api.diagProcesses(pc.id));
    } catch (e) {
      setProcError(errorText(e));
    } finally {
      setLoadingProcs(false);
    }
  }, [pc.id]);

  useEffect(() => {
    if (online) void loadProcesses();
  }, [online, loadProcesses]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return procs;
    return procs.filter(
      (p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q) || (p.title ?? '').toLowerCase().includes(q),
    );
  }, [procs, filter]);

  const killProc = async (p: DiagProcess) => {
    setKillingPid(p.pid);
    try {
      const res = await api.diagKillProcess(pc.id, p.pid);
      if (res.ok) {
        toast('ok', res.message);
        setProcs((prev) => prev.filter((x) => x.pid !== p.pid));
      } else {
        toast('warn', res.message);
      }
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setKillingPid(null);
    }
  };

  const restartExplorer = async () => {
    setRestartingExp(true);
    try {
      const res = await api.diagRestartExplorer(pc.id);
      toast(res.ok ? 'ok' : 'error', res.message);
      if (res.ok) void loadProcesses();
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setRestartingExp(false);
    }
  };

  const takeScreenshot = async () => {
    setCapturing(true);
    setScreenError(null);
    try {
      setScreen(await api.diagScreenshot(pc.id));
    } catch (e) {
      setScreenError(errorText(e));
    } finally {
      setCapturing(false);
    }
  };

  const downloadShot = () => {
    if (!screen) return;
    const a = document.createElement('a');
    a.href = `data:image/jpeg;base64,${screen.jpegBase64}`;
    a.download = `pc-${pc.id}-screen.jpg`;
    a.click();
  };

  return (
    <Modal
      wide
      title={t('diag.title', { id: pc.id })}
      icon={<Activity size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="toolbar-row" style={{ marginBottom: 12 }}>
        <button className="btn small" disabled={!online || loadingProcs} onClick={() => void loadProcesses()}>
          {loadingProcs ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
          {t('diag.refreshProcs')}
        </button>
        <button className="btn small" disabled={!online || restartingExp} onClick={() => void restartExplorer()}>
          {restartingExp ? <LoaderCircle size={14} className="spin" /> : <FolderSync size={14} />}
          {t('diag.restartExplorer')}
        </button>
        <button className="btn small primary" disabled={!online || capturing} onClick={() => void takeScreenshot()}>
          {capturing ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}
          {t('diag.screenshot')}
        </button>
        <span className="spacer" />
        <div className="search">
          <Search size={14} />
          <input
            className="input"
            style={{ width: 230, height: 30 }}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('diag.procFilter')}
          />
        </div>
      </div>

      {screenError && <div className="errors">{screenError}</div>}
      {screen ? (
        <div className="diag-shot-box">
          <div className="diag-shot-bar">
            <span className="dim">
              {t('diag.screenCaption', {
                w: screen.width,
                h: screen.height,
                time: new Date(screen.takenAt).toLocaleTimeString(locale),
              })}
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={downloadShot}>
              <Download size={13} /> JPG
            </button>
          </div>
          <img src={`data:image/jpeg;base64,${screen.jpegBase64}`} alt={`PC #${pc.id}`} />
        </div>
      ) : (
        <div className="hint" style={{ marginBottom: 10 }}>
          {t('diag.screenHint')}
        </div>
      )}

      {procError && <div className="errors">{procError}</div>}

      <div className="plan-wrap" style={{ maxHeight: 340 }}>
        {filtered.length === 0 ? (
          <div className="dim" style={{ padding: '14px 4px' }}>
            {loadingProcs ? t('app.loading') : t('diag.noProcs')}
          </div>
        ) : (
          <table className="scan">
            <thead>
              <tr>
                <th>{t('diag.colProcess')}</th>
                <th>{t('diag.colPid')}</th>
                <th>{t('diag.colCpu')}</th>
                <th>{t('diag.colRam')}</th>
                <th>{t('diag.colWindow')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.pid}>
                  <td className="mono">{p.name}</td>
                  <td className="mono dim">{p.pid}</td>
                  <td className="mono">{p.cpuPct.toFixed(1)}%</td>
                  <td className="mono">{p.ramMb.toFixed(0)} MB</td>
                  <td className="dim" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.title}>
                    {p.title || '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn small danger"
                      disabled={!online || killingPid === p.pid}
                      onClick={() => setConfirmKill(p)}
                    >
                      {killingPid === p.pid ? <LoaderCircle size={13} className="spin" /> : <Skull size={13} />}
                      {t('diag.kill')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmKill && (
        <ConfirmDialog
          title={t('diag.killConfirmTitle', { name: confirmKill.name, pid: confirmKill.pid })}
          text={t('diag.killConfirmText')}
          confirmLabel={t('diag.kill')}
          danger
          onConfirm={() => void killProc(confirmKill)}
          onClose={() => setConfirmKill(null)}
        />
      )}
    </Modal>
  );
}
