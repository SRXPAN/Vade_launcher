import { FolderOpen, Layers, LoaderCircle, PackageOpen, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AFTER_ACTION_TITLES, orderQueue, type AppSettings, type PcRecord, type PcRuntime } from '@vade/protocol';
import type { AgentSource, QueueCountsUi } from '../shared/api';
import { api, errorText } from './api';
import { Modal, useToast } from './ui';

/* ------------------------------------------------------------------ */
/* Progress bar shown above the grid while a queue / rollout runs      */
/* ------------------------------------------------------------------ */

export function RunBar(props: { title: string; active: boolean; counts: QueueCountsUi; onCancel: () => void; onDismiss: () => void }) {
  const c = props.counts;
  return (
    <div className="runbar">
      {props.active ? <LoaderCircle size={16} className="spin" color="var(--accent)" /> : <Layers size={16} color="var(--text-3)" />}
      <strong>{props.title}</strong>
      <div className="counts">
        <span>
          Виконується: <b>{c.running}</b>
        </span>
        <span>
          У черзі: <b>{c.queued}</b>
        </span>
        <span className="s-ok">
          Готово: <b>{c.done}</b>
        </span>
        {c.failed > 0 && (
          <span className="s-error">
            Помилки: <b>{c.failed}</b>
          </span>
        )}
        {c.skipped > 0 && (
          <span className="dim">
            Пропущено: <b>{c.skipped}</b>
          </span>
        )}
        {c.cancelled > 0 && (
          <span className="dim">
            Скасовано: <b>{c.cancelled}</b>
          </span>
        )}
      </div>
      <span className="spacer" />
      {props.active ? (
        <button className="btn small" onClick={props.onCancel}>
          Скасувати
        </button>
      ) : (
        <button className="icon-btn" title="Сховати" onClick={props.onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "Оновити агент"                                                     */
/* ------------------------------------------------------------------ */

export function AgentUpdateDialog({ pcIds, runtimes, onClose }: { pcIds: number[]; runtimes: Record<number, PcRuntime>; onClose: () => void }) {
  const toast = useToast();
  const [bundled, setBundled] = useState<AgentSource | null | undefined>(undefined);
  const [picked, setPicked] = useState<AgentSource | null>(null);
  const [useFile, setUseFile] = useState(false);
  const [includeSame, setIncludeSame] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getBundledAgent().then(setBundled);
  }, []);

  const source = useFile ? picked : bundled ?? null;
  const rows = pcIds.map((id) => {
    const rt = runtimes[id];
    const online = rt?.link === 'online';
    const v = rt?.info?.version;
    const willUpdate = online && !!source && (includeSame || v !== source.version);
    return { id, online, v, willUpdate };
  });
  const count = rows.filter((r) => r.willUpdate).length;

  const pick = async () => {
    setError(null);
    try {
      const s = await api.pickAgentFile();
      if (s) {
        setPicked(s);
        setUseFile(true);
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const start = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    const r = await api.startAgentUpdate({ pcIds: rows.filter((x) => x.online).map((x) => x.id), source: useFile ? source.path : 'bundled', includeSameVersion: includeSame });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'Помилка');
    toast('info', `Оновлення агента до ${source.version} запущено`);
    onClose();
  };

  const describe = (s: AgentSource) => `v${s.version} · ${(s.size / 1024 / 1024).toFixed(1)} МБ · sha256 ${s.sha256.slice(0, 12)}…`;

  return (
    <Modal
      title="Оновити агент по мережі"
      icon={<PackageOpen size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={busy || !source || count === 0} onClick={() => void start()}>
            {busy && <LoaderCircle size={15} className="spin" />} Оновити {count} ПК
          </button>
        </>
      }
    >
      {error && <div className="errors">{error}</div>}
      <div className="radio-row" style={{ flexDirection: 'column', gap: 8 }}>
        <label>
          <input type="radio" checked={!useFile} onChange={() => setUseFile(false)} disabled={!bundled} /> Агент із цієї адмінки:{' '}
          {bundled === undefined ? '…' : bundled ? <span className="mono">{describe(bundled)}</span> : <span className="dim">не знайдено (npm run build:agent)</span>}
        </label>
        <label>
          <input type="radio" checked={useFile} onChange={() => (picked ? setUseFile(true) : void pick())} /> Інший файл:{' '}
          {picked ? <span className="mono">{describe(picked)}</span> : <span className="dim">не вибрано</span>}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={() => void pick()}>
            <FolderOpen size={14} /> Вибрати…
          </button>
        </label>
        <label>
          <input type="checkbox" checked={includeSame} onChange={(e) => setIncludeSame(e.target.checked)} /> Перевстановити і там, де вже ця версія
        </label>
      </div>
      <div className="notice" style={{ margin: '12px 0' }}>
        <ShieldCheck size={16} />
        <span>
          Адмін-ПК роздає файл по HTTP (порт 7421) лише на час оновлення; агент перевіряє sha256 і перезапускає службу (~20 с). Якщо нова версія не
          стартує — автоматичний відкат. Одночасно оновлюються до 4 ПК. Якщо Windows спитає про брандмауер для Vade Launcher — дозвольте для
          приватної мережі.
        </span>
      </div>
      <table className="scan">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ width: 70 }}>ПК №{r.id}</td>
              <td className="mono">{r.v ? `v${r.v}` : '—'}</td>
              <td>
                {!r.online ? (
                  <span className="dim">не в мережі — пропуск</span>
                ) : r.willUpdate ? (
                  <span className="s-running">оновиться{source ? ` до v${source.version}` : ''}</span>
                ) : (
                  <span className="dim">вже ця версія</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* "Обслуговування чергою"                                             */
/* ------------------------------------------------------------------ */

export function QueueDialog({ pcIds, pcs, settings, onClose }: { pcIds: number[]; pcs: PcRecord[]; settings: AppSettings; onClose: () => void }) {
  const toast = useToast();
  const [keepOn, setKeepOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const order = useMemo(
    () => orderQueue(pcs.filter((p) => pcIds.includes(p.id)), settings.schedule.zoneOrder),
    [pcs, pcIds, settings.schedule.zoneOrder],
  );
  const n = settings.schedule.maxConcurrentUpdates;

  const start = async () => {
    setBusy(true);
    const r = await api.startQueue({ pcIds: order.map((p) => p.id), mode: keepOn ? 'test' : 'manual' });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'Помилка');
    toast('info', `Черга з ${order.length} ПК запущена, одночасно ${n}`);
    onClose();
  };

  return (
    <Modal
      title={`Обслуговування чергою: ${order.length} ПК`}
      icon={<Layers size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={busy || order.length === 0} onClick={() => void start()}>
            Запустити чергу
          </button>
        </>
      }
    >
      {error && <div className="errors">{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        Одночасно обслуговується <strong>{n}</strong> ПК (змінюється на вкладці «Розклад і завдання»). Щойно один завершить, стартує наступний. Вимкнені ПК
        отримують Wake-on-LAN, коли настає їхня черга (очікування до 3 хв). Зайняті гравцями — в кінець черги, потім пропуск.
      </p>
      <div className="radio-row" style={{ marginBottom: 12 }}>
        <label>
          <input type="radio" checked={keepOn} onChange={() => setKeepOn(true)} /> Залишити ПК увімкненими
        </label>
        <label>
          <input type="radio" checked={!keepOn} onChange={() => setKeepOn(false)} /> Після завершення: {AFTER_ACTION_TITLES[settings.maintenance.after.action]}
        </label>
      </div>
      <div className="hint">Порядок: {order.map((p) => `№${p.id}`).join(' → ') || '—'}</div>
    </Modal>
  );
}
