/**
 * Shared data model for Vade Launcher.
 * Used by the admin app (main + renderer) and by the client agent.
 * Everything here must stay JSON-serialisable.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_AGENT_PORT = 7420;
export const DEFAULT_DISCOVERY_PORT = 7422;

/* ------------------------------------------------------------------ */
/* Admin-side configuration                                            */
/* ------------------------------------------------------------------ */

export type Zone = string;
export const KNOWN_ZONES = ['Regular', 'Stream'] as const;

export type AfterAction = 'none' | 'sleep' | 'hibernate' | 'shutdown';
export type PowerAction = 'sleep' | 'hibernate' | 'shutdown' | 'restart';
/** Which games SteamCMD updates: every installed game, or only listed AppIDs. */
export type UpdateMode = 'auto' | 'list';
/** Which Workshop content is removed: all games, or only listed AppIDs. */
export type WorkshopMode = 'all' | 'list';

export interface ExtraUpdaterApp {
  id: string;
  name: string;
  exePath: string;
  args?: string;
  enabled: boolean;
}

export interface ExtraUpdatersConfig {
  enabled: boolean;
  apps: ExtraUpdaterApp[];
  minWaitMin: number;
  maxWaitMin: number;
  idleKbps: number;
}

export interface MaintenanceConfig {
  /** Night (scheduled) maintenance is not started while a player is on the PC */
  skipIfOccupied: boolean;
  /** Steam client folder, e.g. C:\Program Files (x86)\Steam */
  steamPath: string;
  /** SteamCMD folder, e.g. C:\steamcmd */
  steamcmdDir: string;
  cleanTemp: boolean;
  cleanSteamLogins: boolean;
  cleanSteamCache: boolean;
  cleanUserdata: boolean;
  workshop: {
    enabled: boolean;
    mode: WorkshopMode;
    appIds: number[];
  };
  update: {
    enabled: boolean;
    /** Club Steam login. The password is never stored. */
    steamUser: string;
    mode: UpdateMode;
    appIds: number[];
    /** AppIDs skipped in 'auto' mode (e.g. player-installed games not owned by the club account) */
    ignoreAppIds: number[];
    /** When false (default), 'No subscription' / missing-license does not mark the job/PC as Error */
    treatNoSubscriptionAsError: boolean;
    validate: boolean;
  };
  extraUpdaters: ExtraUpdatersConfig;
  after: {
    action: AfterAction;
    /** 30..60 seconds between the end of the work and the power action. */
    delaySec: number;
  };
}

/**
 * staggered: every PC starts on its own at startTime + (N - 1) * stepMin (works without the admin PC);
 * queue:     at startTime the admin PC runs a queue with at most maxConcurrentUpdates PCs at a time.
 */
export type ScheduleMode = 'staggered' | 'queue';

export interface ScheduleSettings {
  enabled: boolean;
  /** HH:MM, start time of PC #1 (staggered) or of the whole queue */
  startTime: string;
  /** Minutes between PC N and PC N+1 */
  stepMin: number;
  /** Wake-on-LAN is sent this many minutes before the PC's slot */
  wolLeadMin: number;
  /** If the PC comes online late, the agent still starts the job this many minutes after its slot */
  catchUpMin: number;
  mode: ScheduleMode;
  /** queue mode: how many PCs download updates at the same time (1..10) */
  maxConcurrentUpdates: number;
  /** queue mode: zones first in this order, e.g. ["Stream", "Regular"]; the rest by PC number */
  zoneOrder: string[];
  /** Automatically resync Windows time (NTP) when drift exceeds 120 seconds */
  autoSyncTime: boolean;
}

export interface NetworkSettings {
  /** CIDR of the club LAN, used by the network scanner */
  subnet: string;
  /** Directed broadcast address for Wake-on-LAN */
  broadcast: string;
  agentPort: number;
  wolPort: number;
  /** Auto-update PC IP by MAC when an agent broadcasts a UDP discovery beacon */
  discoveryEnabled: boolean;
  /** UDP port for discovery beacons (default 7422) */
  discoveryPort: number;
}

export interface SecuritySettings {
  /** Shared secret between the admin app and all agents. Never sent over the wire. */
  clubKey: string;
  /** Optional salted SHA-256 hash of Admin PIN ("<saltHex>:<hashHex>"); empty/omitted = disabled */
  pinHash?: string;
  /** How long Owner mode stays unlocked after PIN entry (minutes, default 20) */
  ownerSessionMin: number;
}

/* ------------------------------------------------------------------ */
/* Occupancy detector ("is a player sitting at this PC?")             */
/* ------------------------------------------------------------------ */

export type Occupancy = 'free' | 'occupied' | 'unknown';

export type OccupancyReason =
  | 'game_running'
  | 'senet_session'
  | 'senet_locked'
  | 'windows_locked'
  | 'active_input'
  | 'idle'
  | 'no_session'
  | 'no_input_data'
  | 'probe_failed'
  | 'disabled';

export interface DetectorSettings {
  enabled: boolean;
  /** Mouse/keyboard input within this many minutes = a player is there */
  idleMinutes: number;
  /** Game executables, e.g. cs2.exe (case-insensitive, ".exe" optional) */
  gameProcesses: string[];
  /** Processes of the SENET client shell; empty = SENET is not taken into account */
  senetProcesses: string[];
  /** Window title fragments of the SENET login/lock screen; empty = any SENET window in front */
  senetLockTitles: string[];
}

/** Raw signals of the player's session, for the admin's diagnostics only (never sent to the site). */
export interface PresenceInfo {
  user: string;
  idleSec: number;
  locked: boolean;
  foreground: string;
  foregroundTitle: string;
  game?: string;
}

/* ------------------------------------------------------------------ */
/* Post-session quick clean (after the client leaves)                 */
/* ------------------------------------------------------------------ */

export type BrowserId = 'chrome' | 'edge' | 'opera' | 'firefox';
export type LauncherId = 'riot' | 'epic' | 'battlenet' | 'ea' | 'discord' | 'telegram';
export type CleanLaunchersSettings = Record<LauncherId, boolean>;

export interface PostSessionCleanSettings {
  enabled: boolean;
  /** Wait after occupied -> free before cleaning (the client may only be topping up time) */
  delaySec: number;
  /** loginusers.vdf, ssfn*, local.vdf, AutoLoginUser / RememberPassword */
  cleanSteamLogins: boolean;
  /** Processes closed before cleaning, e.g. steam.exe, discord.exe */
  closeApps: string[];
  /** Cookies, saved logins, sessions and site storage of the browsers below (bookmarks stay) */
  cleanBrowsers: boolean;
  browsers: BrowserId[];
  /** Remove saved account tokens / web caches of launchers & messengers */
  cleanLaunchers: CleanLaunchersSettings;
}

export interface QuickCleanInfo {
  at: string;
  trigger: 'auto' | 'manual';
  ok: boolean;
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Disks & Hardware Health                                             */
/* ------------------------------------------------------------------ */

export interface DiskInfo {
  /** "C:" */
  drive: string;
  freeBytes: number;
  totalBytes: number;
}

export interface SsdHealth {
  model: string;
  healthStatus: string;
  wearPct: number | null;
  tempC: number | null;
}

export interface HardwareHealth {
  ramTotalGb: number;
  refreshRateHz: number | null;
  ssd: SsdHealth[];
  gpuTempC: number | null;
  cpuTempC: number | null;
}

export interface HealthThresholds {
  /** Minimum expected RAM in GB (0 = disabled) */
  minRamGb: number;
  /** Minimum expected primary monitor refresh rate in Hz (0 = disabled) */
  minRefreshRateHz: number;
  /** GPU temperature warning threshold in °C (0 = disabled) */
  maxGpuTempC: number;
  /** SSD wear percentage warning threshold 0..100 (0 = disabled) */
  maxSsdWearPct: number;
}

export interface AlertSettings {
  /** Less free space than this = yellow */
  diskWarnGb: number;
  /** Less free space than this = red */
  diskCritGb: number;
  minRamGb: number;
  minRefreshRateHz: number;
  maxGpuTempC: number;
  maxSsdWearPct: number;
  /** Optional per-zone overrides (e.g. "Stream", "VIP") */
  zoneThresholds?: Record<string, Partial<HealthThresholds>>;
}

/* ------------------------------------------------------------------ */
/* Club website integration (webhook from the admin PC)               */
/* ------------------------------------------------------------------ */

export interface SiteSettings {
  enabled: boolean;
  /** POST endpoint, e.g. https://our-site.com/api/club-status */
  url: string;
  /** Sent as "Authorization: Bearer <token>" */
  token: string;
  /** Send even without changes this often (keeps "updatedAt" fresh) */
  heartbeatSec: number;
  /** Status changes are collected for this long before one request is sent */
  debounceSec: number;
  /** Max successful requests per UTC day (Cloudflare KV Free: 1000 writes/day). 0 = unlimited */
  dailyLimit: number;
}

/** What the public booking map gets. No IPs, MACs, names, keys or logs. */
export type PublicPcStatus = 'free' | 'occupied' | 'maintenance' | 'offline';

export interface SitePayload {
  updatedAt: string;
  pcs: Array<{ id: number; zone: string; status: PublicPcStatus }>;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type AppLanguage = 'uk' | 'pl' | 'en';

export type AdminRole = 'operator' | 'owner';

export type AuditAction =
  | 'pc.wol'
  | 'pc.shutdown'
  | 'pc.restart'
  | 'pc.sleep'
  | 'pc.hibernate'
  | 'pc.cancel_power'
  | 'pc.maintenance'
  | 'pc.maintenance_cancel'
  | 'pc.clean'
  | 'pc.sync_time'
  | 'pc.steam_login'
  | 'pc.save'
  | 'pc.delete'
  | 'pc.repair_set'
  | 'pc.repair_clear'
  | 'pc.note_set'
  | 'diag.kill'
  | 'diag.restart_explorer'
  | 'diag.screenshot'
  | 'diag.notify'
  | 'diag.restore_hz'
  | 'diag.restart_launcher'
  | 'deploy.exec'
  | 'deploy.file'
  | 'agent.update'
  | 'queue.start'
  | 'queue.cancel'
  | 'settings.save'
  | 'settings.regen_key'
  | 'settings.pin_change'
  | 'map.save'
  | 'backup.export'
  | 'backup.import'
  | 'shift.open'
  | 'shift.close'
  | 'role.unlock'
  | 'role.lock'
  | 'games.install'
  | 'games.uninstall'
  | (string & {});

export interface AuditEntry {
  id: string;
  ts: string;
  role: AdminRole;
  operatorName?: string;
  action: AuditAction;
  targets: string[];
  details?: string;
}

export interface PcServiceNote {
  outOfService: boolean;
  text: string;
  updatedAt: number;
  author?: string;
}

export interface BackupSettings {
  autoEnabled: boolean;
  dir: string;
  keepCount: number;
  lastAutoBackupAt?: string;
}

export interface HealthTelemetrySettings {
  enabled: boolean;
  pollIntervalSec: number;
  collectTemps: boolean;
  collectSmart: boolean;
}

/** Admin app behaviour (not sent to agents). */
export interface UiSettings {
  /** Start the admin app with Windows (needed for night Wake-on-LAN) */
  autostart: boolean;
  /** Closing the window keeps the app running in the tray */
  closeToTray: boolean;
  /** Colour theme for the entire admin app (including the club map) */
  theme: ThemeMode;
  /** Interface language */
  language: AppLanguage;
  /** Number of days to retain job history records in history.json (default 14) */
  historyRetentionDays: number;
}

export interface AppSettings {
  version: 1;
  network: NetworkSettings;
  schedule: ScheduleSettings;
  maintenance: MaintenanceConfig;
  /** Official Steam AppIDs expected to be installed across the club */
  clubAppIds: number[];
  detector: DetectorSettings;
  postSessionClean: PostSessionCleanSettings;
  alerts: AlertSettings;
  health: HealthTelemetrySettings;
  security: SecuritySettings;
  backup: BackupSettings;
  site: SiteSettings;
  ui: UiSettings;
}

/** Per-PC deviations from the global settings. Undefined = use global. */
export interface PcOverrides {
  /** false = this PC is skipped by the night schedule (manual runs still work) */
  scheduleEnabled?: boolean;
  afterAction?: AfterAction;
  /** Update only these AppIDs on this PC */
  updateAppIds?: number[];
}

export interface PcRecord {
  /** Table number, unique. Also defines the schedule slot. */
  id: number;
  ip: string;
  /** Normalised lower-case aa:bb:cc:dd:ee:ff */
  mac: string;
  zone: Zone;
  name?: string;
  overrides?: PcOverrides;
  serviceNote?: PcServiceNote;
}

/* ------------------------------------------------------------------ */
/* Agent-side configuration (pushed by the admin app)                  */
/* ------------------------------------------------------------------ */

export interface AgentSchedule {
  enabled: boolean;
  /** HH:MM local time when THIS PC starts its night job */
  runTime: string;
  /** Wake timer (RTC) fires this many minutes before runTime */
  wakeLeadMin: number;
  catchUpMin: number;
}

export interface AgentConfigPayload {
  /** Hash of the payload, lets both sides see whether the agent is up to date */
  rev: string;
  pcId: number;
  maintenance: MaintenanceConfig;
  schedule: AgentSchedule;
  detector: DetectorSettings;
  postSessionClean: PostSessionCleanSettings;
  health?: HealthTelemetrySettings;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

/** test = run now, no power action after. manual = run now with power action. scheduled = night run. */
export type JobMode = 'test' | 'manual' | 'scheduled';

export type StepId =
  | 'closeSteam'
  | 'cleanTemp'
  | 'steamLogins'
  | 'steamCache'
  | 'userdata'
  | 'workshop'
  | 'update'
  | 'extraUpdaters'
  | 'after';

export type StepStatus = 'pending' | 'running' | 'ok' | 'skipped' | 'error';

export interface JobStepState {
  id: StepId;
  status: StepStatus;
  note?: string;
}

export type AppUpdateStatus =
  | 'pending'
  | 'updating'
  | 'ok'
  | 'ignored'
  | 'skipped_no_subscription'
  | 'error'
  | 'login_error';

export interface AppResult {
  appId: number;
  name?: string;
  library: string;
  status: AppUpdateStatus;
  message?: string;
}

export interface JobProgress {
  appId: number;
  /** 0..100 */
  pct: number;
  /** e.g. "downloading", "verifying", "committing" */
  phase: string;
  doneBytes: number;
  totalBytes: number;
}

export type JobResult = 'ok' | 'errors' | 'cancelled';

export interface JobState {
  id: string;
  mode: JobMode;
  startedAt: string;
  finishedAt?: string;
  steps: JobStepState[];
  apps: AppResult[];
  progress: JobProgress | null;
  errors: number;
  result?: JobResult;
}

export interface JobHistoryAppError {
  appId: number;
  name?: string;
  status: AppUpdateStatus;
  message?: string;
}

export interface JobHistoryEntry {
  id: string;
  pcId: number;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  mode: JobMode;
  result: JobResult;
  updatedApps: number;
  errorApps: JobHistoryAppError[];
  errors: number;
}

/* ------------------------------------------------------------------ */
/* Agent status                                                        */
/* ------------------------------------------------------------------ */

export type AgentState = 'idle' | 'cleaning' | 'updating' | 'steam-login' | 'powering';

export interface PendingPower {
  action: PowerAction;
  /** ISO time when the action fires */
  at: string;
}

export interface AgentStatus {
  state: AgentState;
  job: JobState | null;
  lastJob: JobState | null;
  nextRunAt: string | null;
  pendingPower: PendingPower | null;
  configRev: string | null;
  steamcmdInstalled: boolean;
  dryRun: boolean;
  /** Is a player sitting at the PC (missing in agents older than 0.2) */
  occupancy?: Occupancy;
  occupancyReason?: OccupancyReason;
  /** Human readable explanation, e.g. "cs2.exe · Player · 0 хв без дій" */
  occupancyDetail?: string;
  presence?: PresenceInfo | null;
  /** Local fixed disks, refreshed every 60 s (agents 0.3+) */
  disks?: DiskInfo[];
  /** Automatic post-session clean is armed and fires at this time */
  quickCleanAt?: string | null;
  lastQuickClean?: QuickCleanInfo | null;
  /** Hardware & peripheral health metrics (RAM, monitor Hz, GPU temp, SSD SMART) */
  health?: HardwareHealth | null;
  /** Agent's local Date.now() epoch ms when this status was built (for NTP drift detection) */
  agentTimeMs?: number;
}

export interface AgentNic {
  name: string;
  mac: string;
  ip: string;
}

export interface AgentInfo {
  protocol: number;
  version: string;
  hostname: string;
  nics: AgentNic[];
  os: string;
  startedAt: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'steam';

export interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  jobId?: string;
}

/* ------------------------------------------------------------------ */
/* Admin-side runtime view of one PC (main process -> renderer)        */
/* ------------------------------------------------------------------ */

export type LinkState = 'offline' | 'connecting' | 'online' | 'auth-failed' | 'incompatible';

export type DisplayStatus = 'online' | 'offline' | 'sleeping' | 'cleaning' | 'updating' | 'error';

export interface PcRuntime {
  pcId: number;
  link: LinkState;
  info: AgentInfo | null;
  status: AgentStatus | null;
  /** PC was sent to sleep/hibernate and has not come back yet */
  sleeping: boolean;
  lastSeen: string | null;
  lastError: string | null;
  wolSentAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Games Matrix (Stage 1)                                              */
/* ------------------------------------------------------------------ */

export interface InstalledSteamGame {
  appId: number;
  name: string;
  libraryPath: string;
  installDir?: string;
  sizeOnDiskBytes: number;
}

export interface GamesUninstallResult {
  ok: boolean;
  appId: number;
  removedFiles: number;
  failedFiles: number;
  message: string;
}

export interface GamesInstallResult {
  ok: boolean;
  appId: number;
  status: AppUpdateStatus;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Quick Diagnostics & Bundle (Stages 2 & 6)                           */
/* ------------------------------------------------------------------ */

export interface DiagProcess {
  pid: number;
  name: string;
  cpuPct: number;
  ramMb: number;
  sessionId?: number;
  title?: string;
}

export interface DiagScreenshotResult {
  jpegBase64: string;
  width: number;
  height: number;
  takenAt: string;
}

export interface DiagActionResult {
  ok: boolean;
  message: string;
}

export interface DiagBundleResult {
  collectedAt: string;
  hostname: string;
  agentVersion: string;
  os: string;
  agentConfig: Record<string, unknown>;
  agentLog: string;
  steamcmdLast: string;
  systemInfo: Record<string, unknown>;
}

export type RestartLauncherApp = 'steam' | 'riot';

export interface DiagNotifyArgs {
  title: string;
  message: string;
  timeoutSec?: number;
}

export interface DiagRestoreRefreshRateArgs {
  targetHz: number;
}

export interface DiagRestartLauncherArgs {
  app: RestartLauncherApp;
}

/* ------------------------------------------------------------------ */
/* Broadcast / Deploy (Stage 3)                                        */
/* ------------------------------------------------------------------ */

export type DeployShell = 'powershell' | 'cmd';

export interface DeployExecArgs {
  shell: DeployShell;
  script: string;
  timeoutSec: number;
}

export interface DeployExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface DeployFileArgs {
  url: string;
  sha256: string;
  targetPath: string;
}

export interface DeployFileResult {
  ok: boolean;
  bytes: number;
  targetPath: string;
  message: string;
}
