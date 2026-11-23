import { ChevronDown, ChevronRight, FolderOpen, LoaderCircle, Send, Terminal } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import type { AppSettings, DeployShell, PcRuntime } from '@vade/protocol';
import type { DeployRunStatus, PickedDeployFile } from '../shared/api';
import { api, errorText } from './api';
import { fmtBytes } from './format';
import { useI18n } from './i18n';
import { useRole } from './role';
import { Modal, Segmented, useToast } from './ui';

interface Props {
  pcIds: number[];
  runtimes: Record<number, PcRuntime>;
  settings: AppSettings;
  onClose: () => void;
}

type Mode = 'exec' | 'file';

export function DeployDialog({ pcIds, runtimes, settings: _settings, onClose }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const { requireOwner } = useRole();
  const [mode, setMode] = useState<Mode>('exec');
  const [shell, setShell] = useState<DeployShell>('powershell');
  const [timeoutSec, setTimeoutSec] = useState(60);
  const [script, setScript] = useState('');
  const [picked, setPicked] = useState<PickedDeployFile | null>(null);
  const [targetPath, setTargetPath] = useState('C:\\Games\\');
  const [status, setStatus] = useState<DeployRunStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  useEffect(() => {
    void api.getDeployStatus().then(setStatus);
    return api.onDeployStatus(setStatus);
  }, []);

  const onlineTargets = pcIds.filter((id) => runtimes[id]?.link === 'online');
  const isActive = !!status?.active;

  const pickFile = async () => {
    setError(null);
    try {
      const f = await api.pickDeployFile();
      if (f) {
        setPicked(f);
        setTargetPath((prev) => (prev.endsWith('\\') || prev === 'C:\\Games\\' ? `C:\\Games\\${f.name}` : prev));
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const execute = async (pin?: string) => {
    setStarting(true);
    setError(null);
    try {
      const res =
        mode === 'exec'
          ? await api.startDeployExec({ pcIds, shell, script, timeoutSec, pin })
          : await api.startDeployFile({ pcIds, localPath: picked!.path, targetPath, pin });
      if (!res.ok) {
        setError(res.error ?? t('deploy.startError'));
        return;
      }
      toast('info', `${mode === 'exec' ? t('deploy.tabExec') : t('deploy.tabFile')} (${t('common.pcsCount', { count: onlineTargets.length })})`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const onStartClick = () => {
    setError(null);
    if (mode === 'exec' && !script.trim()) return;
    if (mode === 'file' && (!picked || !targetPath.trim())) return;
    requireOwner(t('pcs.deployAction'), () => void execute());
  };

  const canRun =
    !starting &&
    !isActive &&
    onlineTargets.length > 0 &&
    (mode === 'exec' ? !!script.trim() : !!picked && !!targetPath.trim());

  return (
    <Modal
      wide
      title={t('deploy.title', { count: pcIds.length })}
      icon={mode === 'exec' ? <Terminal size={18} color="var(--accent)" /> : <Send size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          {isActive ? (
            <button className="btn danger" onClick={() => void api.cancelDeploy()}>
              {t('deploy.cancelRun')}
            </button>
          ) : null}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="btn primary" disabled={!canRun} onClick={onStartClick}>
            {starting && <LoaderCircle size={15} className="spin" />}
            {mode === 'exec'
              ? t('deploy.runExec', { count: onlineTargets.length })
              : t('deploy.runFile', { count: onlineTargets.length })}
          </button>
        </>
      }
    >
      <div className="toolbar-row" style={{ marginBottom: 12 }}>
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'exec', label: t('deploy.tabExec') },
            { value: 'file', label: t('deploy.tabFile') },
          ]}
        />
        <span className="spacer" />
        <span className="dim" style={{ fontSize: 12 }}>
          Online: {onlineTargets.length} / {pcIds.length}
        </span>
      </div>

      {error && <div className="errors">{error}</div>}

      {mode === 'exec' ? (
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <div className="field">
            <label>{t('deploy.shell')}</label>
            <Segmented<DeployShell>
              value={shell}
              onChange={setShell}
              options={[
                { value: 'powershell', label: 'PowerShell' },
                { value: 'cmd', label: 'CMD' },
              ]}
            />
          </div>
          <div className="field">
            <label>{t('deploy.timeout')}</label>
            <input
              className="input"
              type="number"
              min={5}
              max={600}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
          </div>
          <div className="field full">
            <label>{t('deploy.scriptLabel')}</label>
            <textarea
              className="input mono"
              rows={4}
              value={script}
              spellCheck={false}
              placeholder={t('deploy.scriptPlaceholder')}
              onChange={(e) => setScript(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <div className="field full">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn small" type="button" onClick={() => void pickFile()}>
                <FolderOpen size={14} /> {t('deploy.pickFile')}
              </button>
              {picked ? (
                <span className="mono" style={{ fontSize: 12 }}>
                  {picked.name} ({fmtBytes(picked.size)} · sha256 {picked.sha256.slice(0, 12)}…)
                </span>
              ) : (
                <span className="dim">{t('deploy.noFile')}</span>
              )}
            </div>
          </div>
          <div className="field full">
            <label>{t('deploy.targetPath')}</label>
            <input
              className="input mono"
              value={targetPath}
              placeholder={t('deploy.targetPlaceholder')}
              onChange={(e) => setTargetPath(e.target.value)}
            />
          </div>
        </div>
      )}

      {status && (
        <div className="deploy-results">
          <div className="deploy-summary">
            <strong>{status.title}</strong>
            <span className="spacer" />
            <span className="s-ok">OK: {status.counts.done}</span>
            {status.counts.failed > 0 && <span className="s-error">Err: {status.counts.failed}</span>}
            {status.counts.running > 0 && <span className="s-running">Run: {status.counts.running}</span>}
          </div>
          <div className="plan-wrap" style={{ maxHeight: 260 }}>
            <table className="scan">
              <tbody>
                {status.items.map((item) => {
                  const hasOut = !!(item.exec?.stdout.trim() || item.exec?.stderr.trim());
                  const open = !!expanded[item.pcId];
                  const cls =
                    item.state === 'done'
                      ? 's-ok'
                      : item.state === 'failed'
                        ? 's-error'
                        : item.state === 'running'
                          ? 's-running'
                          : 'dim';
                  return (
                    <Fragment key={item.pcId}>
                      <tr>
                        <td style={{ width: 80 }}>
                          <strong>{t('common.pcNum', { id: item.pcId })}</strong>
                        </td>
                        <td className={cls}>{item.message || t(`queue.${item.state}`)}</td>
                        <td style={{ width: 32, textAlign: 'right' }}>
                          {hasOut && (
                            <button
                              className="icon-btn"
                              style={{ width: 26, height: 26 }}
                              onClick={() => setExpanded((e) => ({ ...e, [item.pcId]: !open }))}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          )}
                        </td>
                      </tr>
                      {hasOut && open && (
                        <tr>
                          <td colSpan={3}>
                            <pre className="deploy-out">
                              {item.exec?.stdout.trim() ? item.exec.stdout.trim() : ''}
                              {item.exec?.stderr.trim() ? `\n[STDERR]\n${item.exec.stderr.trim()}` : ''}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
