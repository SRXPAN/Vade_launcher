import { AlertTriangle, CheckCircle2, History } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JobHistoryEntry, PcRecord } from '@vade/protocol';
import { api } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';

interface Props {
  pcs: PcRecord[];
}

const MODE_LABEL = {
  scheduled: 'Нічний',
  manual: 'Ручний',
  test: 'Тест',
} as const;

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} хв ${s} с` : `${m} хв`;
}

export function HistoryView({ pcs }: Props) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<JobHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pcFilter, setPcFilter] = useState<string>('all');
  const [daysFilter, setDaysFilter] = useState<number>(14);
  const [onlyErrors, setOnlyErrors] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.listHistory().then((list) => {
      if (alive) {
        setEntries(list);
        setLoading(false);
      }
    });
    const off = api.onHistoryChanged((list) => setEntries(list));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pcById = useMemo(() => new Map(pcs.map((p) => [p.id, p])), [pcs]);

  const problemPcs = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const map = new Map<number, { count: number; lastErrorAt: string; lastMs: number; apps: Set<string> }>();
    for (const e of entries) {
      if (e.result !== 'errors') continue;
      const ms = Date.parse(e.finishedAt || e.startedAt);
      if (!Number.isFinite(ms) || ms < cutoff) continue;
      let bucket = map.get(e.pcId);
      if (!bucket) {
        bucket = { count: 0, lastErrorAt: e.finishedAt || e.startedAt, lastMs: ms, apps: new Set() };
        map.set(e.pcId, bucket);
      }
      bucket.count++;
      if (ms > bucket.lastMs) {
        bucket.lastMs = ms;
        bucket.lastErrorAt = e.finishedAt || e.startedAt;
      }
      for (const a of e.errorApps) bucket.apps.add(a.name ? `${a.name} (${a.appId})` : String(a.appId));
    }
    return [...map.entries()]
      .filter(([, v]) => v.count >= 2)
      .map(([pcId, v]) => ({ pcId, errorCount: v.count, lastErrorAt: v.lastErrorAt, failedApps: [...v.apps] }))
      .sort((a, b) => b.errorCount - a.errorCount || a.pcId - b.pcId);
  }, [entries]);

  const filtered = useMemo(() => {
    const cutoff = daysFilter > 0 ? Date.now() - daysFilter * 86_400_000 : 0;
    return entries.filter((e) => {
      if (pcFilter !== 'all' && e.pcId !== Number(pcFilter)) return false;
      if (onlyErrors && e.result !== 'errors') return false;
      if (cutoff > 0) {
        const ms = Date.parse(e.finishedAt || e.startedAt);
        if (!Number.isFinite(ms) || ms < cutoff) return false;
      }
      return true;
    });
  }, [entries, pcFilter, daysFilter, onlyErrors]);

  return (
    <div className="page">
      <div className="page-title">
        <h1>{t('history.title')}</h1>
        <span className="dim">{t('history.subtitle')}</span>
      </div>

      <section className="section">
        <h2>
          {problemPcs.length > 0 ? <AlertTriangle size={17} color="var(--warn)" /> : <CheckCircle2 size={17} color="var(--ok)" />} Проблемні ПК (2+ помилки за останні 7 днів)
        </h2>
        {problemPcs.length === 0 ? (
          <div className="hint" style={{ marginBottom: 0 }}>
            Системних збоїв не виявлено — усі столи стабільні за останні 7 днів.
          </div>
        ) : (
          <div className="problem-grid">
            {problemPcs.map((p) => {
              const rec = pcById.get(p.pcId);
              return (
                <button
                  key={p.pcId}
                  type="button"
                  className="problem-card"
                  onClick={() => setPcFilter(String(p.pcId))}
                  title="Фільтрувати таблицю за цим ПК"
                >
                  <div className="problem-card-head">
                    <strong>ПК №{p.pcId}</strong>
                    {rec && <span className={`tag zone-${rec.zone}`}>{rec.zone}</span>}
                    <span className="spacer" />
                    <span className="badge st-error">{p.errorCount} помилок</span>
                  </div>
                  <div className="dim" style={{ fontSize: 12 }}>
                    Востаннє: {fmtDateTime(p.lastErrorAt)}
                  </div>
                  {p.failedApps.length > 0 && (
                    <div className="problem-apps" title={p.failedApps.join(', ')}>
                      {p.failedApps.slice(0, 3).join(', ')}
                      {p.failedApps.length > 3 ? ` (+${p.failedApps.length - 3})` : ''}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <h2>
          <History size={17} /> Журнал завдань
        </h2>
        <div className="toolbar-row" style={{ margin: '8px 0 12px' }}>
          <select className="input" value={pcFilter} onChange={(e) => setPcFilter(e.target.value)}>
            <option value="all">Усі ПК ({entries.length})</option>
            {pcs.map((p) => (
              <option key={p.id} value={String(p.id)}>
                ПК №{p.id} ({p.zone})
              </option>
            ))}
          </select>
          <select className="input" value={daysFilter} onChange={(e) => setDaysFilter(Number(e.target.value))}>
            <option value={1}>За 24 години</option>
            <option value={3}>За 3 дні</option>
            <option value={7}>За 7 днів</option>
            <option value={14}>За 14 днів</option>
            <option value={0}>Увесь збережений період</option>
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Лише помилки
          </label>
          <span className="spacer" />
          <span className="dim" style={{ fontSize: 12 }}>
            Показано записів: {filtered.length}
          </span>
        </div>

        {loading ? (
          <div className="dim">Завантаження…</div>
        ) : filtered.length === 0 ? (
          <div className="dim" style={{ padding: '16px 0' }}>
            Записів за вибраними фільтрами немає. Історія накопичується автоматично після завершення завдань обслуговування.
          </div>
        ) : (
          <div className="plan-wrap" style={{ maxHeight: 540 }}>
            <table className="plan">
              <thead>
                <tr>
                  <th>Завершено</th>
                  <th>ПК</th>
                  <th>Режим</th>
                  <th>Тривалість</th>
                  <th>Статус</th>
                  <th>Оновлено ігор</th>
                  <th>Помилки / деталі</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const rec = pcById.get(e.pcId);
                  return (
                    <tr key={`${e.pcId}:${e.id}`}>
                      <td>{fmtDateTime(e.finishedAt, locale, t('common.todayTime'))}</td>
                      <td>
                        <strong>№{e.pcId}</strong> {rec ? <span className={`tag zone-${rec.zone}`}>{rec.zone}</span> : null}
                      </td>
                      <td>{MODE_LABEL[e.mode]}</td>
                      <td>{fmtDuration(e.durationSec)}</td>
                      <td>
                        <span className={`badge ${e.result === 'ok' ? 'st-online' : e.result === 'errors' ? 'st-error' : 'st-offline'}`}>
                          {e.result === 'ok' ? 'OK' : e.result === 'errors' ? `Помилок: ${e.errors}` : 'Скасовано'}
                        </span>
                      </td>
                      <td>{e.updatedApps}</td>
                      <td style={{ maxWidth: 340 }}>
                        {e.errorApps.length > 0 ? (
                          <span className="s-error" style={{ fontSize: 12 }}>
                            {e.errorApps.map((a) => `${a.name ?? a.appId}${a.message ? ` (${a.message})` : ''}`).join('; ')}
                          </span>
                        ) : e.result === 'errors' ? (
                          <span className="dim" style={{ fontSize: 12 }}>
                            Помилка кроку обслуговування (див. лог ПК)
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
