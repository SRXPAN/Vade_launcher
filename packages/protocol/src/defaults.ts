import type {
  AlertSettings,
  AppSettings,
  BackupSettings,
  BrowserId,
  CleanLaunchersSettings,
  DetectorSettings,
  ExtraUpdatersConfig,
  HealthTelemetrySettings,
  LauncherId,
  PostSessionCleanSettings,
  MaintenanceConfig,
  Occupancy,
  OccupancyReason,
  PcRecord,
  PublicPcStatus,
  SiteSettings,
  StepId,
  TvDisplayConfig,
} from './types';
import { DEFAULT_AGENT_PORT, DEFAULT_DISCOVERY_PORT, DEFAULT_TV_PORT } from './types';

export const DEFAULT_EXTRA_UPDATERS: ExtraUpdatersConfig = {
  enabled: false,
  apps: [
    {
      id: 'riot',
      name: 'Riot Client',
      exePath: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
      args: '--launch-product=valorant --launch-patchline=live',
      enabled: true,
    },
    {
      id: 'epic',
      name: 'Epic Games Launcher',
      exePath: 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe',
      args: '-silent',
      enabled: true,
    },
    {
      id: 'faceit',
      name: 'FACEIT AC',
      exePath: 'C:\\Program Files\\FACEIT AC\\faceitclient.exe',
      args: '',
      enabled: true,
    },
  ],
  minWaitMin: 3,
  maxWaitMin: 20,
  idleKbps: 200,
};

/** Mirrors the SETTINGS block of the old club_night_sleep.bat */
export const DEFAULT_MAINTENANCE: MaintenanceConfig = {
  skipIfOccupied: true,
  steamPath: 'C:\\Program Files (x86)\\Steam',
  steamcmdDir: 'C:\\steamcmd',
  cleanTemp: true,
  cleanSteamLogins: true,
  cleanSteamCache: true,
  cleanUserdata: false,
  workshop: { enabled: true, mode: 'all', appIds: [730] },
  update: {
    enabled: true,
    steamUser: 'vadekrarow',
    mode: 'auto',
    appIds: [730, 570, 578080],
    ignoreAppIds: [],
    treatNoSubscriptionAsError: false,
    validate: false,
  },
  extraUpdaters: structuredClone(DEFAULT_EXTRA_UPDATERS),
  after: { action: 'hibernate', delaySec: 30 },
};

export const DEFAULT_DETECTOR: DetectorSettings = {
  enabled: true,
  idleMinutes: 10,
  gameProcesses: [
    'cs2.exe',
    'dota2.exe',
    'VALORANT-Win64-Shipping.exe',
    'TslGame.exe',
    'FortniteClient-Win64-Shipping.exe',
    'r5apex.exe',
    'League of Legends.exe',
    'RocketLeague.exe',
    'Overwatch.exe',
    'GTA5.exe',
    'RainbowSix.exe',
    'Marvel-Win64-Shipping.exe',
    'project8.exe',
  ],
  // SENET process / lock screen names differ between versions: see them in the PC's live log panel.
  senetProcesses: [],
  senetLockTitles: [],
};

export const BROWSER_IDS: BrowserId[] = ['chrome', 'edge', 'opera', 'firefox'];

export const BROWSER_TITLES: Record<BrowserId, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  opera: 'Opera / Opera GX',
  firefox: 'Mozilla Firefox',
};

/** Process that must be closed before the browser's profile files can be removed. */
export const BROWSER_PROCESSES: Record<BrowserId, string> = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  opera: 'opera.exe',
  firefox: 'firefox.exe',
};

export const LAUNCHER_IDS: LauncherId[] = ['riot', 'epic', 'battlenet', 'ea', 'discord', 'telegram'];

export const LAUNCHER_TITLES: Record<LauncherId, string> = {
  riot: 'Riot Client',
  epic: 'Epic Games',
  battlenet: 'Battle.net',
  ea: 'EA App',
  discord: 'Discord',
  telegram: 'Telegram Desktop',
};

export const LAUNCHER_PROCESSES: Record<LauncherId, string[]> = {
  riot: ['RiotClientServices.exe', 'RiotClientUx.exe', 'RiotClientUxRender.exe'],
  epic: ['EpicGamesLauncher.exe'],
  battlenet: ['Battle.net.exe'],
  ea: ['EADesktop.exe', 'EABackgroundService.exe'],
  discord: ['Discord.exe'],
  telegram: ['Telegram.exe'],
};

export const DEFAULT_CLEAN_LAUNCHERS: CleanLaunchersSettings = {
  riot: true,
  epic: true,
  battlenet: true,
  ea: true,
  discord: true,
  telegram: false,
};

export const DEFAULT_POST_SESSION_CLEAN: PostSessionCleanSettings = {
  enabled: true,
  delaySec: 45,
  cleanSteamLogins: true,
  closeApps: ['steam.exe', 'steamwebhelper.exe', 'discord.exe', 'chrome.exe', 'msedge.exe', 'opera.exe'],
  cleanBrowsers: true,
  browsers: [...BROWSER_IDS],
  cleanLaunchers: { ...DEFAULT_CLEAN_LAUNCHERS },
};

export const DEFAULT_ALERTS: AlertSettings = {
  diskWarnGb: 30,
  diskCritGb: 15,
  minRamGb: 32,
  minRefreshRateHz: 240,
  maxGpuTempC: 85,
  maxSsdWearPct: 80,
};

export const DEFAULT_HEALTH_TELEMETRY: HealthTelemetrySettings = {
  enabled: true,
  pollIntervalSec: 60,
  collectTemps: true,
  collectSmart: true,
};

export const DEFAULT_BACKUP: BackupSettings = {
  autoEnabled: false,
  dir: '',
  keepCount: 7,
};

/** Changes only + heartbeat every 10 min: fits Cloudflare KV Free (1000 writes/day). */
export const DEFAULT_SITE: SiteSettings = {
  enabled: false,
  url: '',
  token: '',
  heartbeatSec: 600,
  debounceSec: 2,
  dailyLimit: 900,
};

/** clubKey is filled with a random value on the first start of the admin app */
export function defaultSettings(clubKey: string): AppSettings {
  return {
    version: 1,
    network: {
      subnet: '10.70.4.0/24',
      broadcast: '10.70.4.255',
      agentPort: DEFAULT_AGENT_PORT,
      wolPort: 9,
      discoveryEnabled: true,
      discoveryPort: DEFAULT_DISCOVERY_PORT,
    },
    schedule: {
      enabled: true,
      startTime: '11:00',
      stepMin: 1,
      wolLeadMin: 2,
      catchUpMin: 30,
      mode: 'staggered',
      maxConcurrentUpdates: 3,
      zoneOrder: [],
      autoSyncTime: true,
    },
    maintenance: structuredClone(DEFAULT_MAINTENANCE),
    clubAppIds: [730, 570, 578080],
    detector: structuredClone(DEFAULT_DETECTOR),
    postSessionClean: structuredClone(DEFAULT_POST_SESSION_CLEAN),
    alerts: { ...DEFAULT_ALERTS },
    health: { ...DEFAULT_HEALTH_TELEMETRY },
    security: { clubKey, pinHash: '', ownerSessionMin: 20 },
    backup: { ...DEFAULT_BACKUP },
    site: { ...DEFAULT_SITE },
    ui: { autostart: true, closeToTray: true, theme: 'system', language: 'uk', historyRetentionDays: 14 },
  };
}

export const OCCUPANCY_TITLES: Record<Occupancy, string> = {
  free: 'Вільний',
  occupied: 'Зайнятий',
  unknown: 'Невідомо',
};

export const OCCUPANCY_REASON_TITLES: Record<OccupancyReason, string> = {
  game_running: 'запущена гра',
  senet_session: 'клієнт увійшов у SENET',
  senet_locked: 'SENET: екран входу',
  windows_locked: 'Windows заблоковано',
  active_input: 'активні миша / клавіатура',
  idle: 'немає активності',
  no_session: 'ніхто не увійшов у Windows',
  no_input_data: 'немає даних про активність',
  probe_failed: 'детектор не відповідає',
  disabled: 'детектор вимкнено',
};

export const PUBLIC_STATUS_TITLES: Record<PublicPcStatus, string> = {
  free: 'вільний',
  occupied: 'зайнятий',
  maintenance: 'обслуговування',
  offline: 'вимкнений',
};

/** Initial pcs.json written on the first start */
export const SEED_PCS: PcRecord[] = [
  { id: 1, mac: '30:56:0f:3e:93:88', ip: '10.70.4.112', zone: 'Regular' },
  { id: 2, mac: '30:56:0f:3e:91:0a', ip: '10.70.4.115', zone: 'Regular' },
  { id: 3, mac: '30:56:0f:3e:91:83', ip: '10.70.4.118', zone: 'Regular' },
  { id: 4, mac: '30:56:0f:3e:91:8f', ip: '10.70.4.119', zone: 'Regular' },
  { id: 5, mac: '30:56:0f:3e:94:6a', ip: '10.70.4.122', zone: 'Regular' },
  { id: 6, mac: '30:56:0f:3e:94:fd', ip: '10.70.4.152', zone: 'Regular' },
  { id: 7, mac: '30:56:0f:3e:93:7a', ip: '10.70.4.149', zone: 'Regular' },
  { id: 12, mac: '30:56:0f:3e:93:43', ip: '10.70.4.105', zone: 'Regular' },
  { id: 13, mac: '30:56:0f:3e:91:a6', ip: '10.70.4.106', zone: 'Regular' },
  { id: 14, mac: '30:56:0f:3e:91:7e', ip: '10.70.4.107', zone: 'Regular' },
  { id: 15, mac: '30:56:0f:3e:94:e9', ip: '10.70.4.120', zone: 'Regular' },
  { id: 16, mac: '30:56:0f:3e:90:96', ip: '10.70.4.108', zone: 'Regular' },
  { id: 17, mac: '30:56:0f:3e:97:98', ip: '10.70.4.109', zone: 'Regular' },
  { id: 18, mac: '30:56:0f:3e:92:7d', ip: '10.70.4.144', zone: 'Stream' },
  { id: 19, mac: '30:56:0f:3e:91:4c', ip: '10.70.4.121', zone: 'Stream' },
  { id: 23, mac: '30:56:0f:3e:92:d0', ip: '10.70.4.114', zone: 'Regular' },
  { id: 24, mac: '30:56:0f:3e:91:b8', ip: '10.70.4.124', zone: 'Regular' },
  { id: 25, mac: '30:56:0f:3e:91:89', ip: '10.70.4.125', zone: 'Regular' },
  { id: 26, mac: '30:56:0f:3e:91:ad', ip: '10.70.4.197', zone: 'Regular' },
  { id: 27, mac: '30:56:0f:3e:93:53', ip: '10.70.4.127', zone: 'Regular' },
  { id: 28, mac: '30:56:0f:3e:91:af', ip: '10.70.4.129', zone: 'Regular' },
  { id: 29, mac: '30:56:0f:3e:92:d6', ip: '10.70.4.128', zone: 'Regular' },
];

export const STEP_TITLES: Record<StepId, string> = {
  closeSteam: 'Закриття Steam',
  cleanTemp: 'Очищення TEMP',
  steamLogins: 'Видалення логінів Steam',
  steamCache: 'Очищення кешу Steam',
  userdata: 'Видалення userdata',
  workshop: 'Очищення Майстерні',
  update: 'Оновлення ігор (SteamCMD)',
  extraUpdaters: 'Оновлення лаунчерів (поза Steam)',
  after: 'Дія після завершення',
};

export const AFTER_ACTION_TITLES = {
  none: 'Нічого не робити',
  sleep: 'Сон',
  hibernate: 'Гібернація',
  shutdown: 'Вимкнення',
} as const;

export const TV_LIMITS = {
  maxSlides: 8,
  maxQrCards: 4,
  minDurationSec: 5,
  maxDurationSec: 30,
  defaultDurationSec: 8,
  minPort: 1024,
  maxPort: 65535,
  maxDataUrlBytes: 1_500_000,
} as const;

export function defaultTvConfig(): TvDisplayConfig {
  return {
    updatedAt: 0,
    lang: 'pl',
    defaultSlideDurationSec: TV_LIMITS.defaultDurationSec,
    localServerEnabled: true,
    localServerPort: DEFAULT_TV_PORT,
    slides: [],
    qrCards: [],
  };
}
