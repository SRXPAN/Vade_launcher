import { LoaderCircle, Plus, Radar, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, PcRecord } from '@vade/protocol';
import type { ScanHost, ScanProgress } from '../shared/api';
import { api, errorText } from './api';
import { useI18n } from './i18n';
import { Modal, useToast } from './ui';

interface Props {
  pcs: PcRecord[];
  settings: AppSettings;
  onClose: () => void;
  onAdd: (ip: string, mac: string) => void;
  onPcsChanged: (pcs: PcRecord[]) => void;
}

type Row = { host: ScanHost; byIp?: PcRecord; byMac?: PcRecord };

export function ScanDialog({ pcs, settings, onClose, onAdd, onPcsChanged }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [hosts, setHosts] = useState<ScanHost[] | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setProgress(null);
    const off = api.onScanProgress(setProgress);
    try {
      setHosts(await api.scan());
    } catch (e) {
      setError(errorText(e));
    } finally {
      off();
      setScanning(false);
    }
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows: Row[] = (hosts ?? []).map((host) => ({
    host,
    byIp: pcs.find((p) => p.ip === host.ip),
    byMac: host.mac ? pcs.find((p) => p.mac === host.mac) : undefined,
  }));

  const update = async (pc: PcRecord, patch: Partial<PcRecord>, what: string) => {
    const r = await api.savePc({ ...pc, ...patch }, pc.id);
    if (r.ok) {
      onPcsChanged(r.pcs);
      toast('ok', `ПК №${pc.id}: ${what}`);
    } else toast('error', r.errors.join('\n'));
  };

  const newCount = rows.filter((r) => !r.byIp && !r.byMac && !r.host.self && r.host.mac).length;

  return (
    <Modal
      wide
      title={`Сканування мережі ${settings.network.subnet}`}
      icon={<Radar size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <span className="dim" style={{ marginRight: 'auto', fontSize: 13 }}>
            {hosts && !scanning && `Знайдено пристроїв: ${hosts.length}, нових з MAC: ${newCount}`}
          </span>
          <button className="btn" disabled={scanning} onClick={() => void scan()}>
            <RefreshCw size={15} /> Сканувати ще раз
          </button>
          <button className="btn primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Ping по всіх адресах підмережі + перевірка порту агента {settings.network.agentPort} + таблиця ARP Windows. MAC-адреси видно навіть у ПК,
        що блокують ping. Вимкнені ПК не відповідають — їх додавайте вручну.
      </p>
      {error && <div className="errors">{error}</div>}
      {scanning && (
        <div style={{ margin: '14px 0' }}>
          <div className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <LoaderCircle size={15} className="spin" /> Сканування… {progress ? `${progress.done} / ${progress.total}` : ''}
          </div>
          <div className="progress">
            <i style={{ width: progress ? `${(progress.done / progress.total) * 100}%` : '0%' }} />
          </div>
        </div>
      )}
      {hosts && !scanning && (
        <div style={{ maxHeight: 460, overflow: 'auto' }}>
          <table className="scan">
            <thead>
              <tr>
                <th>IP</th>
                <th>MAC</th>
                <th>Ping</th>
                <th>Агент</th>
                <th>Стан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ host, byIp, byMac }) => {
                let state: ReactNode = <span className="s-running">Новий пристрій</span>;
                let action: ReactNode = host.mac ? (
                  <button className="btn small" onClick={() => onAdd(host.ip, host.mac!)}>
                    <Plus size={14} /> Додати
                  </button>
                ) : null;
                if (host.self) {
                  state = <span className="dim">Цей ПК (адмін)</span>;
                  action = null;
                } else if (byIp) {
                  const macDiffers = !!host.mac && host.mac !== byIp.mac;
                  state = macDiffers ? <span className="s-error">ПК №{byIp.id}: MAC відрізняється</span> : <span className="s-ok">ПК №{byIp.id}</span>;
                  action = macDiffers ? (
                    <button className="btn small" onClick={() => void update(byIp, { mac: host.mac! }, `MAC оновлено на ${host.mac}`)}>
                      Оновити MAC
                    </button>
                  ) : null;
                } else if (byMac) {
                  state = <span className="s-error">ПК №{byMac.id}: IP змінився ({byMac.ip})</span>;
                  action = (
                    <button className="btn small" onClick={() => void update(byMac, { ip: host.ip }, `IP оновлено на ${host.ip}`)}>
                      Оновити IP
                    </button>
                  );
                }
                return (
                  <tr key={host.ip}>
                    <td className="mono">{host.ip}</td>
                    <td className="mono">{host.mac ?? <span className="dim">—</span>}</td>
                    <td>{host.alive ? <span className="s-ok">{t('common.yes')}</span> : <span className="dim">{t('common.no')}</span>}</td>
                    <td>{host.agent ? <span className="s-ok">{t('common.yes')}</span> : <span className="dim">{t('common.no')}</span>}</td>
                    <td>{state}</td>
                    <td style={{ textAlign: 'right' }}>{action}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
