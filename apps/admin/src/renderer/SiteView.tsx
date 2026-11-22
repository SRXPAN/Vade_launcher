import { CircleCheck, CircleX, Eye, EyeOff, Globe, Info, LoaderCircle, Plug, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildSitePayload, PUBLIC_STATUS_TITLES, type AppSettings, type PcRecord, type PcRuntime, type PublicPcStatus } from '@vade/protocol';
import type { SiteEvent, SiteStatus, SiteTestResult } from '../shared/api';
import { api, errorText } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';
import { SaveBar } from './SaveBar';
import { Option } from './ui';
import { useDraft } from './useDraft';

interface Props {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  pcs: PcRecord[];
  runtimes: Record<number, PcRuntime>;
}

const EVENT_LABEL: Record<SiteEvent, string> = { change: 'зміна', heartbeat: 'heartbeat', test: 'тест' };

function fmtInterval(sec: number): string {
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${+(sec / 60).toFixed(1)} хв`;
  return `${+(sec / 3600).toFixed(1)} год`;
}

export function SiteView({ settings, onSaved, pcs, runtimes }: Props) {
  const { t, locale } = useI18n();
  const { draft, update, dirty, reset, save, error, saving } = useDraft(settings, onSaved);
  const site = draft.site;
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<SiteTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSiteStatus().then(setStatus);
    return api.onSiteStatus(setStatus);
  }, []);

  const payload = useMemo(() => buildSitePayload(pcs, (id) => runtimes[id]), [pcs, runtimes]);
  const counts = useMemo(() => {
    const c: Record<PublicPcStatus, number> = { free: 0, occupied: 0, maintenance: 0, offline: 0 };
    for (const p of payload.pcs) c[p.status]++;
    return c;
  }, [payload]);

  const heartbeatsPerDay = Math.ceil(86_400 / Math.max(15, site.heartbeatSec || 600));
  const overBudget = site.dailyLimit > 0 && heartbeatsPerDay >= site.dailyLimit;
  const usedPct = status && status.dailyLimit > 0 ? Math.min(100, (status.sentToday / status.dailyLimit) * 100) : 0;

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await api.testSite(site.url, site.token));
    } catch (e) {
      setTestError(errorText(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-title">
        <h1>{t('site.title')}</h1>
        <span className="dim">{t('site.subtitle')}</span>
      </div>
      {error && <div className="errors">{error}</div>}
      <div className="cols">
        <div>
          <section className="section">
            <h2>
              <Globe size={17} /> Синхронізація статусів
            </h2>
            <div className="hint">
              Головний ПК надсилає POST із JSON на сайт: одразу при зміні статусу будь-якого ПК (зміни за {site.debounceSec} с об'єднуються в один запит) і
              heartbeat, якщо змін не було {fmtInterval(site.heartbeatSec)}.
            </div>
            <Option title="Синхронізацію увімкнено" on={site.enabled} onChange={(v) => update((d) => void (d.site.enabled = v))} />
            <div className="form-grid" style={{ marginTop: 6 }}>
              <div className="field full">
                <label>Webhook URL</label>
                <input
                  className="input mono"
                  value={site.url}
                  placeholder="https://our-site.com/api/club-status"
                  spellCheck={false}
                  onChange={(e) => update((d) => void (d.site.url = e.target.value))}
                />
                {site.url.startsWith('http://') && <span className="hint" style={{ color: 'var(--warn)' }}>Без https токен іде відкритим текстом.</span>}
              </div>
              <div className="field full">
                <label>API Secret / Bearer Token</label>
                <div className="key-row">
                  <input
                    className="input"
                    type={showToken ? 'text' : 'password'}
                    value={site.token}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="надсилається як Authorization: Bearer <token>"
                    onChange={(e) => update((d) => void (d.site.token = e.target.value))}
                  />
                  <button className="icon-btn" style={{ width: 32, height: 32 }} title={showToken ? 'Сховати' : 'Показати'} onClick={() => setShowToken((v) => !v)}>
                    {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Heartbeat без змін, с</label>
                <input className="input" type="number" min={15} max={86400} value={site.heartbeatSec} onChange={(e) => update((d) => void (d.site.heartbeatSec = Number(e.target.value)))} />
                <span className="hint">= {fmtInterval(site.heartbeatSec)} · ≈{heartbeatsPerDay} запитів/добу</span>
              </div>
              <div className="field">
                <label>Debounce змін, с</label>
                <input className="input" type="number" min={0} max={60} value={site.debounceSec} onChange={(e) => update((d) => void (d.site.debounceSec = Number(e.target.value)))} />
                <span className="hint">Зміни за цей час — один запит.</span>
              </div>
              <div className="field">
                <label>Ліміт запитів на добу (UTC)</label>
                <input className="input" type="number" min={0} value={site.dailyLimit} onChange={(e) => update((d) => void (d.site.dailyLimit = Number(e.target.value)))} />
                <span className="hint">0 = без ліміту. Cloudflare KV Free: 1000 записів/добу.</span>
              </div>
            </div>
            {overBudget && (
              <div className="notice warn" style={{ marginTop: 12 }}>
                <TriangleAlert size={16} />
                <span>Лише heartbeat дає ≈{heartbeatsPerDay} запитів на добу — це не менше за ліміт. Збільште інтервал (рекомендовано 600 с).</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn" disabled={testing || !site.url.trim()} onClick={() => void runTest()}>
                {testing ? <LoaderCircle size={15} className="spin" /> : <Plug size={15} />} Тест підключення
              </button>
              {test && (
                <span className={`result-chip ${test.ok ? 's-ok' : 's-error'}`}>
                  {test.ok ? <CircleCheck size={15} /> : <CircleX size={15} />}
                  {test.status ? `HTTP ${test.status} ${test.statusText ?? ''}` : test.error} · {test.ms} мс
                </span>
              )}
              {testError && <span className="s-error">{testError}</span>}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Тест надсилає поточні статуси з заголовком <span className="mono">X-Vade-Event: test</span> (використовує незбережені URL і токен) і не
              рахується в ліміт.
            </div>
          </section>

          <section className="section">
            <h2>Стан відправки</h2>
            {status ? (
              <>
                <div className="hint">
                  Сьогодні (UTC {status.day}): <strong>{status.sentToday}</strong>
                  {status.dailyLimit > 0 ? ` з ${status.dailyLimit}` : ''} успішних запитів
                  {status.lastOkAt ? ` · останній успішний ${fmtDateTime(status.lastOkAt)}` : ''}
                </div>
                {status.dailyLimit > 0 && (
                  <div className={`meter ${usedPct >= 100 ? 'err' : usedPct >= 80 ? 'warn' : ''}`}>
                    <i style={{ width: `${usedPct}%` }} />
                  </div>
                )}
                {status.limitReached && (
                  <div className="notice warn" style={{ margin: '8px 0' }}>
                    <TriangleAlert size={16} />
                    <span>Добовий ліміт вичерпано — відправка відновиться о 00:00 UTC.</span>
                  </div>
                )}
                {status.history.length === 0 ? (
                  <div className="dim" style={{ marginTop: 8 }}>
                    {status.enabled ? 'Ще нічого не надсилалось (перший запит — через ~15 с після запуску).' : 'Синхронізацію вимкнено.'}
                  </div>
                ) : (
                  <table className="plan" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Час</th>
                        <th>Подія</th>
                        <th>Результат</th>
                        <th style={{ textAlign: 'right' }}>мс</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.history.slice(0, 10).map((a, i) => (
                        <tr key={i}>
                          <td>{new Date(a.at).toLocaleTimeString(locale)}</td>
                          <td>{EVENT_LABEL[a.event]}</td>
                          <td className={a.ok ? 's-ok' : 's-error'}>{a.ok ? `HTTP ${a.status}` : a.error}</td>
                          <td style={{ textAlign: 'right' }}>{a.ms}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ) : (
              <div className="dim">Завантаження…</div>
            )}
          </section>
        </div>

        <div>
          <section className="section">
            <h2>
              <ShieldCheck size={17} /> Що бачить сайт
            </h2>
            <div className="hint">
              Лише номер столу, зону і публічний статус. IP, MAC-адреси, назви ПК, ключ клубу, логи та дані гравців не передаються.
            </div>
            <div className="summary" style={{ margin: '4px 0 10px' }}>
              {(Object.keys(counts) as PublicPcStatus[]).map((k) => (
                <span key={k} className={`badge ${k === 'free' ? 'st-online' : k === 'occupied' ? 'st-occ' : k === 'maintenance' ? 'st-updating' : 'st-offline'}`}>
                  {PUBLIC_STATUS_TITLES[k]} {counts[k]}
                </span>
              ))}
            </div>
            <pre className="json">
              {JSON.stringify({ ...payload, pcs: payload.pcs.slice(0, 8) }, null, 2)}
              {payload.pcs.length > 8 ? `\n// … і ще ${payload.pcs.length - 8} ПК у масиві pcs` : ''}
            </pre>
            <table className="plan" style={{ marginTop: 12 }}>
              <tbody>
                <tr>
                  <td className="mono">free</td>
                  <td>агент на зв'язку, гравця немає</td>
                </tr>
                <tr>
                  <td className="mono">occupied</td>
                  <td>гравець за ПК; також коли детектор не може визначити (щоб сайт не пропонував, можливо, зайняте місце)</td>
                </tr>
                <tr>
                  <td className="mono">maintenance</td>
                  <td>іде обслуговування, оновлення або вхід SteamCMD</td>
                </tr>
                <tr>
                  <td className="mono">offline</td>
                  <td>ПК вимкнений, спить або агент недоступний</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="section">
            <h2>
              <Info size={17} /> Запит
            </h2>
            <pre className="json">{`POST ${site.url || 'https://our-site.com/api/club-status'}
Content-Type: application/json
Authorization: Bearer ${site.token ? '••••••••' : '<token>'}
X-Vade-Event: change | heartbeat | test
User-Agent: VadeLauncher/<версія>`}</pre>
            <div className="hint" style={{ marginTop: 8 }}>
              Будь-яка відповідь 2xx — успіх; інакше повтор через 30 с → 1 хв → … (не частіше heartbeat). Приклад приймача на Cloudflare Workers + KV — у
              docs/SITE_INTEGRATION.md.
            </div>
          </section>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}
