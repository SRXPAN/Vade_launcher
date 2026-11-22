import {
  CalendarClock,
  Download,
  Gamepad2,
  Globe,
  HardDrive,
  History,
  Monitor,
  Moon,
  Settings,
  Sun,
  User,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { deriveDisplayStatus, worstDiskLevel, type AppSettings, type PcRecord, type PcRuntime, type ThemeMode } from '@vade/protocol';
import type { AppInfo, AppUpdateState } from '../shared/api';
import { api } from './api';
import { occupancyOf, STATUS_ORDER } from './format';
import { GamesView } from './GamesView';
import { HistoryView } from './HistoryView';
import { I18nProvider, useI18n } from './i18n';
import { PcsView } from './PcsView';
import { ScheduleView } from './ScheduleView';
import { SettingsView } from './SettingsView';
import { SiteView } from './SiteView';
import { ToastProvider, useNow, useToast } from './ui';

type Tab = 'pcs' | 'games' | 'schedule' | 'history' | 'site' | 'settings';

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    setDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

function AppShell(props: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  pcs: PcRecord[];
  setPcs: (p: PcRecord[]) => void;
  runtimes: Record<number, PcRuntime>;
  info: AppInfo | null;
  resolvedTheme: 'dark' | 'light';
  toggleTheme: () => Promise<void>;
}) {
  const { settings, setSettings, pcs, setPcs, runtimes, info, resolvedTheme, toggleTheme } = props;
  const { t, locale } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('pcs');
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    void api.getAppUpdateStatus().then(setUpdateState);
    return api.onAppUpdateStatus(setUpdateState);
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pcs) {
      const s = deriveDisplayStatus(runtimes[p.id]);
      c[s] = (c[s] ?? 0) + 1;
      if (occupancyOf(runtimes[p.id]) === 'occupied') c.occupied = (c.occupied ?? 0) + 1;
      const rt = runtimes[p.id];
      if (rt?.link === 'online' && worstDiskLevel(rt.status?.disks, settings.alerts) === 'crit') c.diskCrit = (c.diskCrit ?? 0) + 1;
    }
    return c;
  }, [pcs, runtimes, settings]);

  const showUpdateBanner = updateState?.phase === 'downloaded' && !!updateState.availableVersion;

  const installAppUpdate = async () => {
    const r = await api.installAppUpdate();
    if (!r.ok && r.error) toast('error', r.error);
  };

  return (
    <div className={`app ${showUpdateBanner ? 'has-banner' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">V</div>
          {t('app.name')}
        </div>
        <nav className="tabs">
          <button className={`tab ${tab === 'pcs' ? 'active' : ''}`} onClick={() => setTab('pcs')}>
            <Monitor size={16} /> {t('nav.pcs')}
          </button>
          <button className={`tab ${tab === 'games' ? 'active' : ''}`} onClick={() => setTab('games')}>
            <Gamepad2 size={16} /> {t('nav.games')}
          </button>
          <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>
            <CalendarClock size={16} /> {t('nav.schedule')}
          </button>
          <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            <History size={16} /> {t('nav.history')}
          </button>
          <button className={`tab ${tab === 'site' ? 'active' : ''}`} onClick={() => setTab('site')}>
            <Globe size={16} /> {t('nav.site')}
          </button>
          <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            <Settings size={16} /> {t('nav.settings')}
          </button>
        </nav>
        <span className="spacer" />
        <div className="summary">
          {counts.diskCrit ? (
            <span className="badge st-error" title={t('badge.lowDiskTitle', { gb: settings.alerts.diskCritGb })}>
              <HardDrive size={12} strokeWidth={2.5} /> {t('badge.lowDisk', { count: counts.diskCrit })}
            </span>
          ) : null}
          {counts.occupied ? (
            <span className="badge st-occ" title={t('badge.occupiedTitle')}>
              <User size={12} strokeWidth={2.5} /> {t('badge.occupied', { count: counts.occupied })}
            </span>
          ) : null}
          {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
            <span key={s} className={`badge st-${s}`}>
              <span className="dot" />
              {t(`status.${s}`)} {counts[s]}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn theme-btn"
          onClick={() => void toggleTheme()}
          title={resolvedTheme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          aria-label={resolvedTheme === 'dark' ? t('settings.themeLight') : t('settings.themeDark')}
        >
          {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <span className="clock">{now.toLocaleTimeString(locale)}</span>
      </header>
      {showUpdateBanner && (
        <div className="update-banner">
          <Download size={15} color="var(--ok)" />
          <span>{t('updateBanner.ready', { version: updateState!.availableVersion! })}</span>
          <button className="btn small primary" onClick={() => void installAppUpdate()}>
            {t('updateBanner.installBtn')}
          </button>
        </div>
      )}
      <main className="content">
        {tab === 'pcs' && <PcsView pcs={pcs} setPcs={setPcs} runtimes={runtimes} settings={settings} onSettingsSaved={setSettings} />}
        {tab === 'games' && <GamesView pcs={pcs} runtimes={runtimes} settings={settings} onSettingsSaved={setSettings} />}
        {tab === 'schedule' && <ScheduleView settings={settings} onSaved={setSettings} pcs={pcs} setPcs={setPcs} />}
        {tab === 'history' && <HistoryView pcs={pcs} />}
        {tab === 'site' && <SiteView settings={settings} onSaved={setSettings} pcs={pcs} runtimes={runtimes} />}
        {tab === 'settings' && <SettingsView settings={settings} onSaved={setSettings} info={info} />}
      </main>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pcs, setPcs] = useState<PcRecord[]>([]);
  const [runtimes, setRuntimes] = useState<Record<number, PcRuntime>>({});
  const [info, setInfo] = useState<AppInfo | null>(null);
  const systemDark = useSystemDark();

  const themePref: ThemeMode = settings?.ui.theme ?? 'system';
  const resolvedTheme: 'dark' | 'light' = themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const toggleTheme = async () => {
    if (!settings) return;
    const nextTheme: ThemeMode = resolvedTheme === 'dark' ? 'light' : 'dark';
    const next: AppSettings = { ...settings, ui: { ...settings.ui, theme: nextTheme } };
    setSettings(next);
    try {
      setSettings(await api.saveSettings(next));
    } catch {
      setSettings(settings);
    }
  };

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

  if (!settings) return <div className="loading">Завантаження…</div>;

  return (
    <I18nProvider lang={settings.ui.language ?? 'uk'}>
      <ToastProvider>
        <AppShell
          settings={settings}
          setSettings={setSettings}
          pcs={pcs}
          setPcs={setPcs}
          runtimes={runtimes}
          info={info}
          resolvedTheme={resolvedTheme}
          toggleTheme={toggleTheme}
        />
      </ToastProvider>
    </I18nProvider>
  );
}
