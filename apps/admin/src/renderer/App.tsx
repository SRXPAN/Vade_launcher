import { CalendarClock, Globe, HardDrive, Monitor, Settings, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { deriveDisplayStatus, worstDiskLevel, type AppSettings, type PcRecord, type PcRuntime } from '@vade/protocol';
import type { AppInfo } from '../shared/api';
import { api } from './api';
import { occupancyOf, STATUS_LABEL, STATUS_ORDER } from './format';
import { PcsView } from './PcsView';
import { ScheduleView } from './ScheduleView';
import { SettingsView } from './SettingsView';
import { SiteView } from './SiteView';
import { ToastProvider, useNow } from './ui';

type Tab = 'pcs' | 'schedule' | 'site' | 'settings';

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pcs, setPcs] = useState<PcRecord[]>([]);
  const [runtimes, setRuntimes] = useState<Record<number, PcRuntime>>({});
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<Tab>('pcs');
  const now = useNow(1000);

  useEffect(() => {
    const toMap = (list: PcRuntime[]) => Object.fromEntries(list.map((r) => [r.pcId, r]));
    void Promise.all([api.getSettings(), api.listPcs(), api.getRuntimes(), api.getAppInfo()]).then(([s, p, r, i]) => {
      setSettings(s);
      setPcs(p);
      setRuntimes(toMap(r));
      setInfo(i);
    });
    const offRt = api.onRuntimes((list) => setRuntimes(toMap(list)));
    const offPcs = api.onPcsChanged(setPcs);
    return () => {
      offRt();
      offPcs();
    };
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pcs) {
      const s = deriveDisplayStatus(runtimes[p.id]);
      c[s] = (c[s] ?? 0) + 1;
      if (occupancyOf(runtimes[p.id]) === 'occupied') c.occupied = (c.occupied ?? 0) + 1;
      const rt = runtimes[p.id];
      if (settings && rt?.link === 'online' && worstDiskLevel(rt.status?.disks, settings.alerts) === 'crit') c.diskCrit = (c.diskCrit ?? 0) + 1;
    }
    return c;
  }, [pcs, runtimes, settings]);

  if (!settings) return <div className="loading">Завантаження…</div>;

  return (
    <ToastProvider>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <div className="brand-logo">V</div>
            Vade Launcher
          </div>
          <nav className="tabs">
            <button className={`tab ${tab === 'pcs' ? 'active' : ''}`} onClick={() => setTab('pcs')}>
              <Monitor size={16} /> Комп'ютери
            </button>
            <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>
              <CalendarClock size={16} /> Розклад і завдання
            </button>
            <button className={`tab ${tab === 'site' ? 'active' : ''}`} onClick={() => setTab('site')}>
              <Globe size={16} /> Інтеграція з сайтом
            </button>
            <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
              <Settings size={16} /> Налаштування
            </button>
          </nav>
          <span className="spacer" />
          <div className="summary">
            {counts.diskCrit ? (
              <span className="badge st-error" title={`Вільного місця менше за ${settings.alerts.diskCritGb} ГБ`}>
                <HardDrive size={12} strokeWidth={2.5} /> Мало місця {counts.diskCrit}
              </span>
            ) : null}
            {counts.occupied ? (
              <span className="badge st-occ" title="За скільки ПК зараз сидять гравці">
                <User size={12} strokeWidth={2.5} /> Зайнято {counts.occupied}
              </span>
            ) : null}
            {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
              <span key={s} className={`badge st-${s}`}>
                <span className="dot" />
                {STATUS_LABEL[s]} {counts[s]}
              </span>
            ))}
          </div>
          <span className="clock">{now.toLocaleTimeString('uk-UA')}</span>
        </header>
        <main className="content">
          {tab === 'pcs' && <PcsView pcs={pcs} setPcs={setPcs} runtimes={runtimes} settings={settings} onSettingsSaved={setSettings} />}
          {tab === 'schedule' && <ScheduleView settings={settings} onSaved={setSettings} pcs={pcs} setPcs={setPcs} />}
          {tab === 'site' && <SiteView settings={settings} onSaved={setSettings} pcs={pcs} runtimes={runtimes} />}
          {tab === 'settings' && <SettingsView settings={settings} onSaved={setSettings} info={info} />}
        </main>
      </div>
    </ToastProvider>
  );
}
