import { Copy, Cpu, Eye, EyeOff, FolderOpen, HardDrive, KeyRound, Monitor, Network, Package, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { AppSettings, HealthThresholds, ThemeMode } from '@vade/protocol';
import type { AppInfo } from '../shared/api';
import { api, errorText } from './api';
import { SaveBar } from './SaveBar';
import { ConfirmDialog, Option, Segmented, useToast } from './ui';
import { useDraft } from './useDraft';

interface Props {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  info: AppInfo | null;
}

export function SettingsView({ settings, onSaved, info }: Props) {
  const toast = useToast();
  const { draft, update, dirty, reset, save, error, saving } = useDraft(settings, onSaved);
  const [showKey, setShowKey] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const n = draft.network;

  const regen = async () => {
    try {
      onSaved(await api.regenerateClubKey());
      toast('warn', 'Новий ключ створено. Перевстановіть агент на всіх ПК (експортуйте пакет ще раз).');
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const exportPkg = async () => {
    setExporting(true);
    try {
      const r = await api.exportAgentPackage();
      if (r.ok) toast('ok', `Пакет агента збережено:\n${r.path}`);
      else if (r.error) toast('error', r.error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-title">
        <h1>Налаштування</h1>
        {info && <span className="dim">версія {info.version}</span>}
      </div>
      {error && <div className="errors">{error}</div>}
      <div className="cols">
        <div>
          <section className="section">
            <h2>
              <Network size={17} /> Мережа клубу
            </h2>
            <div className="hint">Локальна мережа, без хмари. IP цього ПК: {info?.localIps.join(', ') || '—'}</div>
            <div className="form-grid">
              <div className="field">
                <label>Підмережа (для сканування)</label>
                <input className="input mono" value={n.subnet} onChange={(e) => update((d) => void (d.network.subnet = e.target.value))} />
              </div>
              <div className="field">
                <label>Broadcast для Wake-on-LAN</label>
                <input className="input mono" value={n.broadcast} onChange={(e) => update((d) => void (d.network.broadcast = e.target.value))} />
              </div>
              <div className="field">
                <label>Порт агента (TCP)</label>
                <input className="input" type="number" value={n.agentPort} onChange={(e) => update((d) => void (d.network.agentPort = Number(e.target.value)))} />
              </div>
              <div className="field">
                <label>Порт Wake-on-LAN (UDP)</label>
                <input className="input" type="number" value={n.wolPort} onChange={(e) => update((d) => void (d.network.wolPort = Number(e.target.value)))} />
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <Option
                title="Автопідхоплення зміни IP по MAC (UDP-маяк)"
                desc="Якщо роутер видасть ігровому ПК новий IP по DHCP, агент повідомить свій MAC по UDP, а адмінка автоматично оновить IP у pcs.json і перепідключиться."
                on={n.discoveryEnabled}
                onChange={(v) => update((d) => void (d.network.discoveryEnabled = v))}
              >
                <div className="inline-fields">
                  <div className="field">
                    <label>Порт маяка (UDP)</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={65535}
                      value={n.discoveryPort}
                      onChange={(e) => update((d) => void (d.network.discoveryPort = Number(e.target.value)))}
                    />
                  </div>
                </div>
              </Option>
            </div>
          </section>

          <section className="section">
            <h2>
              <HardDrive size={17} /> Вільне місце на дисках
            </h2>
            <div className="hint">Агенти раз на хвилину надсилають вільне місце всіх локальних дисків; картка ПК підсвічує диск за порогами.</div>
            <div className="form-grid">
              <div className="field">
                <label>
                  <span style={{ color: 'var(--warn)' }}>Жовтий</span>, якщо менше ніж, ГБ
                </label>
                <input className="input" type="number" min={1} value={draft.alerts.diskWarnGb} onChange={(e) => update((d) => void (d.alerts.diskWarnGb = Number(e.target.value)))} />
              </div>
              <div className="field">
                <label>
                  <span style={{ color: 'var(--err)' }}>Червоний</span>, якщо менше ніж, ГБ
                </label>
                <input className="input" type="number" min={1} value={draft.alerts.diskCritGb} onChange={(e) => update((d) => void (d.alerts.diskCritGb = Number(e.target.value)))} />
              </div>
            </div>
          </section>

          <section className="section">
            <h2>
              <Cpu size={17} /> Здоров'я ПК (пороги заліза)
            </h2>
            <div className="hint">
              Контроль RAM, герцовки монітора, температури GPU та зносу SSD. Значення 0 вимикає перевірку порогу.
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Мін. RAM, ГБ</label>
                <input className="input" type="number" min={0} max={1024} value={draft.alerts.minRamGb} onChange={(e) => update((d) => void (d.alerts.minRamGb = Number(e.target.value)))} />
              </div>
              <div className="field">
                <label>Мін. герцовка монітора, Гц</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1000}
                  value={draft.alerts.minRefreshRateHz}
                  onChange={(e) => update((d) => void (d.alerts.minRefreshRateHz = Number(e.target.value)))}
                />
              </div>
              <div className="field">
                <label>Макс. температура GPU, °C</label>
                <input className="input" type="number" min={0} max={120} value={draft.alerts.maxGpuTempC} onChange={(e) => update((d) => void (d.alerts.maxGpuTempC = Number(e.target.value)))} />
              </div>
              <div className="field">
                <label>Макс. знос SSD, %</label>
                <input className="input" type="number" min={0} max={100} value={draft.alerts.maxSsdWearPct} onChange={(e) => update((d) => void (d.alerts.maxSsdWearPct = Number(e.target.value)))} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="label" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                Окремі пороги по зонах (наприклад Stream / VIP)
              </div>
              {Object.entries(draft.alerts.zoneThresholds ?? {}).map(([zoneName, ov]) => {
                const setZoneField = (k: keyof HealthThresholds, val: string) =>
                  update((d) => {
                    const map = (d.alerts.zoneThresholds ??= {});
                    const cur = (map[zoneName] ??= {});
                    if (val.trim() === '') delete cur[k];
                    else cur[k] = Number(val);
                  });
                return (
                  <div key={zoneName} className="extra-app-row" style={{ marginBottom: 8 }}>
                    <div className="extra-app-top">
                      <span className={`tag zone-${zoneName}`}>{zoneName}</span>
                      <span className="spacer" />
                      <button
                        type="button"
                        className="btn small ghost danger"
                        onClick={() =>
                          update((d) => {
                            if (d.alerts.zoneThresholds) delete d.alerts.zoneThresholds[zoneName];
                          })
                        }
                      >
                        Прибрати
                      </button>
                    </div>
                    <div className="inline-fields">
                      <div className="field" style={{ width: 105 }}>
                        <label>RAM ≥ ГБ</label>
                        <input className="input" type="number" placeholder={String(draft.alerts.minRamGb)} value={ov.minRamGb ?? ''} onChange={(e) => setZoneField('minRamGb', e.target.value)} />
                      </div>
                      <div className="field" style={{ width: 105 }}>
                        <label>Гц ≥</label>
                        <input className="input" type="number" placeholder={String(draft.alerts.minRefreshRateHz)} value={ov.minRefreshRateHz ?? ''} onChange={(e) => setZoneField('minRefreshRateHz', e.target.value)} />
                      </div>
                      <div className="field" style={{ width: 105 }}>
                        <label>GPU ≤ °C</label>
                        <input className="input" type="number" placeholder={String(draft.alerts.maxGpuTempC)} value={ov.maxGpuTempC ?? ''} onChange={(e) => setZoneField('maxGpuTempC', e.target.value)} />
                      </div>
                      <div className="field" style={{ width: 105 }}>
                        <label>SSD ≤ %</label>
                        <input className="input" type="number" placeholder={String(draft.alerts.maxSsdWearPct)} value={ov.maxSsdWearPct ?? ''} onChange={(e) => setZoneField('maxSsdWearPct', e.target.value)} />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['Stream', 'VIP', 'Regular'].map((z) =>
                  draft.alerts.zoneThresholds?.[z] ? null : (
                    <button
                      key={z}
                      type="button"
                      className="btn small"
                      onClick={() =>
                        update((d) => {
                          (d.alerts.zoneThresholds ??= {})[z] = {};
                        })
                      }
                    >
                      + Поріг для {z}
                    </button>
                  ),
                )}
              </div>
            </div>
          </section>

          <section className="section">
            <h2>
              <KeyRound size={17} /> Ключ клубу
            </h2>
            <div className="hint">
              Спільний секрет адмінки та агентів. Сам ключ мережею не передається (HMAC challenge-response), ним же шифрується пароль Steam.
            </div>
            <div className="key-row">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                value={draft.security.clubKey}
                onChange={(e) => update((d) => void (d.security.clubKey = e.target.value))}
                spellCheck={false}
              />
              <button className="icon-btn" style={{ width: 32, height: 32 }} title={showKey ? 'Сховати' : 'Показати'} onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                className="icon-btn"
                style={{ width: 32, height: 32 }}
                title="Копіювати"
                onClick={() => void navigator.clipboard.writeText(draft.security.clubKey).then(() => toast('ok', 'Ключ скопійовано'))}
              >
                <Copy size={15} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn danger small" onClick={() => setConfirmRegen(true)}>
                <RefreshCw size={14} /> Згенерувати новий
              </button>
            </div>
            <div className="notice warn" style={{ marginTop: 12 }}>
              <TriangleAlert size={16} />
              <span>Після зміни ключа агенти перестануть приймати команди, доки ви не перевстановите їх з новим пакетом.</span>
            </div>
          </section>
        </div>

        <div>
          <section className="section">
            <h2>
              <Package size={17} /> Агент для ігрових ПК
            </h2>
            <div className="hint">Легкий Windows-сервіс (SYSTEM), що виконує обслуговування, оновлення і команди живлення.</div>
            <ol className="muted" style={{ margin: '4px 0 12px', paddingLeft: 20, lineHeight: 1.7 }}>
              <li>«Експортувати пакет» → оберіть флешку або мережеву папку.</li>
              <li>На ігровому ПК запустіть install.cmd (права адміністратора).</li>
              <li>ПК стане Online → виконайте «Вхід SteamCMD» для нього.</li>
            </ol>
            <button className="btn primary" disabled={exporting || !info?.agentPackageAvailable} onClick={() => void exportPkg()}>
              <Package size={15} /> Експортувати пакет агента
            </button>
            {info && !info.agentPackageAvailable && <div className="hint" style={{ marginTop: 8 }}>Пакет агента не зібрано. Виконайте: npm run build:agent</div>}
            <div className="hint" style={{ marginTop: 10 }}>
              Інсталятор налаштовує живлення (гібернація, таймери пробудження, без пароля після сну — для SENET), брандмауер, Wake-on-LAN на мережевій
              карті та видаляє старе завдання «Club Night» від .bat.
            </div>
          </section>

          <section className="section">
            <h2>
              <Monitor size={17} /> Застосунок
            </h2>
            <div className="opt">
              <div className="opt-text">
                <div className="opt-title">Тема оформлення</div>
                <div className="opt-desc">Синхронно змінює інтерфейс усіх вкладок, діалогів і карти клубу.</div>
              </div>
              <Segmented<ThemeMode>
                value={draft.ui.theme}
                onChange={(v) => update((d) => void (d.ui.theme = v))}
                options={[
                  { value: 'light', label: 'Світла' },
                  { value: 'dark', label: 'Темна' },
                  { value: 'system', label: 'Як у системі' },
                ]}
              />
            </div>
            <Option
              title="Запускати разом з Windows"
              desc="Потрібно для нічного Wake-on-LAN: адмінка має працювати на головному ПК."
              on={draft.ui.autostart}
              onChange={(v) => update((d) => void (d.ui.autostart = v))}
            />
            <Option
              title="Закриття вікна згортає в трей"
              desc="Моніторинг і Wake-on-LAN продовжують працювати у фоні."
              on={draft.ui.closeToTray}
              onChange={(v) => update((d) => void (d.ui.closeToTray = v))}
            />
            <div className="opt">
              <div className="opt-text">
                <div className="opt-title">Зберігати історію запусків, днів</div>
                <div className="opt-desc">Старіші записи автоматично очищуються з history.json.</div>
              </div>
              <input
                className="input"
                style={{ width: 82 }}
                type="number"
                min={1}
                max={365}
                value={draft.ui.historyRetentionDays}
                onChange={(e) => update((d) => void (d.ui.historyRetentionDays = Number(e.target.value)))}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <button className="btn small" onClick={() => void api.openDataDir()}>
                <FolderOpen size={14} /> Папка даних
              </button>
              <span className="dim mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {info?.dataDir}
              </span>
            </div>
          </section>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
      {confirmRegen && (
        <ConfirmDialog
          title="Згенерувати новий ключ клубу?"
          text="Усі встановлені агенти перестануть приймати команди, доки ви не перевстановите їх з новим пакетом."
          confirmLabel="Згенерувати"
          danger
          onConfirm={() => void regen()}
          onClose={() => setConfirmRegen(false)}
        />
      )}
    </div>
  );
}
