/** Contract between the renderer (window.vade) and the Electron main process. */
import type {
  AdminRole,
  AppSettings,
  AuditAction,
  AuditEntry,
  DeployExecResult,
  DeployFileResult,
  DeployShell,
  DiagActionResult,
  DiagNotifyArgs,
  DiagProcess,
  DiagScreenshotResult,
  GamesInstallResult,
  GamesUninstallResult,
  InstalledSteamGame,
  JobHistoryEntry,
  JobMode,
  LogLine,
  PcRecord,
  PcRuntime,
  RestartLauncherApp,
  SteamLoginResult,
  ThemeMode,
} from '@vade/protocol';
import type { MapLayout } from './mapLayout';

export type PcAction =
  | 'wake'
  | 'test'
  | 'run'
  | 'cancel'
  | 'sleep'
  | 'hibernate'
  | 'shutdown'
  | 'restart'
  | 'cancel-power'
  | 'clean-logins'
  | 'sync-time';

export interface ActionResult {
  pcId: number;
  ok: boolean;
  message: string;
  /** e.g. "occupied": the agent refused because a player is on the PC */
  code?: string;
}

export interface ActionOptions {
  /** Start maintenance even if a player is on the PC */
  force?: boolean;
}

export type SiteEvent = 'change' | 'heartbeat' | 'test';

export interface SiteAttempt {
  at: string;
  event: SiteEvent;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

export interface SiteStatus {
  enabled: boolean;
  /** UTC day the counter belongs to (Cloudflare limits reset at 00:00 UTC) */
  day: string;
  sentToday: number;
  dailyLimit: number;
  limitReached: boolean;
  lastAttempt: SiteAttempt | null;
  lastOkAt: string | null;
  history: SiteAttempt[];
}

export type QueueItemStateUi = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface QueueCountsUi {
  running: number;
  queued: number;
  done: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface QueueItemUi {
  pcId: number;
  state: QueueItemStateUi;
  message?: string;
}

/** Maintenance queue (bandwidth control) */
export interface QueueRunStatus {
  active: boolean;
  reason: string;
  mode: JobMode;
  concurrency: number;
  startedAt: string;
  finishedAt?: string;
  counts: QueueCountsUi;
  items: QueueItemUi[];
}

export interface QueueStartRequest {
  pcIds: number[];
  /** test = PCs stay on afterwards, manual = do the configured after-action */
  mode: 'test' | 'manual';
}

export interface AgentSource {
  path: string;
  version: string;
  sha256: string;
  size: number;
  /** Shipped with the admin app */
  bundled: boolean;
}

export interface AgentUpdateStatus {
  version: string;
  active: boolean;
  startedAt: string;
  finishedAt?: string;
  port: number;
  counts: QueueCountsUi;
  items: QueueItemUi[];
}

export interface AgentUpdateRequest {
  pcIds: number[];
  /** "bundled" or the path returned by pickAgentFile() */
  source: 'bundled' | string;
  includeSameVersion: boolean;
}

export interface SiteTestResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  error?: string;
  ms: number;
}

export interface UiLogLine extends LogLine {
  /** Line produced by the admin app itself (WoL sent, link lost, ...) */
  admin?: boolean;
}

export interface LogBatch {
  pcId: number;
  lines: UiLogLine[];
}

export interface ScanHost {
  ip: string;
  mac: string | null;
  alive: boolean;
  agent: boolean;
  self: boolean;
}

export interface ScanProgress {
  done: number;
  total: number;
}

export interface SteamLoginRequest {
  pcIds: number[];
  user: string;
  password: string;
  guardCode?: string;
}

export interface SteamLoginReply {
  pcId: number;
  ok: boolean;
  result?: SteamLoginResult;
  error?: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  localIps: string[];
  agentPackageAvailable: boolean;
}

export type SavePcResult = { ok: true; pcs: PcRecord[] } | { ok: false; errors: string[] };

export interface PcGamesResult {
  pcId: number;
  ok: boolean;
  games: InstalledSteamGame[];
  error?: string;
}

export interface PickedDeployFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

export interface DeployExecRequest {
  pcIds: number[];
  shell: DeployShell;
  script: string;
  timeoutSec: number;
  pin?: string;
}

export interface DeployFileRequest {
  pcIds: number[];
  localPath: string;
  targetPath: string;
  pin?: string;
}

export interface DeployItemStatus {
  pcId: number;
  state: QueueItemStateUi;
  message?: string;
  exec?: DeployExecResult;
  file?: DeployFileResult;
}

export interface DeployRunStatus {
  kind: 'exec' | 'file';
  title: string;
  active: boolean;
  startedAt: string;
  finishedAt?: string;
  counts: QueueCountsUi;
  items: DeployItemStatus[];
}

export type AppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  message?: string;
}

export interface RoleState {
  pinEnabled: boolean;
  role: AdminRole;
  unlockedUntil: number | null;
  ownerSessionMin: number;
  operatorName: string;
}

export interface PcServiceNoteInput {
  outOfService: boolean;
  text: string;
  author?: string;
}

export interface BackupImportResult {
  ok: boolean;
  path?: string;
  preBackupDir?: string;
  settings?: AppSettings;
  pcs?: PcRecord[];
  error?: string;
}

export interface BackupStatus {
  autoEnabled: boolean;
  dir: string;
  keepCount: number;
  lastAutoBackupAt: string | null;
  lastError: string | null;
}

export interface VadeApi {
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  setTheme(theme: ThemeMode): Promise<AppSettings>;
  regenerateClubKey(): Promise<AppSettings>;
  setPin(currentPin: string | undefined, newPin: string | null): Promise<{ ok: boolean; settings?: AppSettings; error?: string }>;
  verifyPin(pin: string): Promise<boolean>;
  getRoleState(): Promise<RoleState>;
  unlockOwner(pin: string): Promise<{ ok: boolean; state: RoleState; error?: string }>;
  lockOwner(): Promise<RoleState>;
  setOperatorName(name: string): Promise<RoleState>;
  onRoleChanged(cb: (s: RoleState) => void): () => void;
  listAudit(): Promise<AuditEntry[]>;
  recordAudit(action: AuditAction, targets: string[], details?: string): Promise<void>;
  onAuditChanged(cb: (entries: AuditEntry[]) => void): () => void;
  listPcs(): Promise<PcRecord[]>;
  savePc(pc: PcRecord, originalId: number | null): Promise<SavePcResult>;
  deletePcs(ids: number[]): Promise<PcRecord[]>;
  setPcServiceNote(pcId: number, note: PcServiceNoteInput | null): Promise<PcRecord[]>;
  /** Club floor map (map_layout.json) */
  getMapLayout(): Promise<MapLayout>;
  /** Normalises and saves the map; returns what was written */
  saveMapLayout(layout: MapLayout): Promise<MapLayout>;
  exportMapLayout(layout: MapLayout): Promise<{ ok: boolean; path?: string; error?: string }>;
  importMapLayout(): Promise<{ ok: boolean; layout?: MapLayout; error?: string }>;
  getRuntimes(): Promise<PcRuntime[]>;
  runAction(action: PcAction, pcIds: number[], opts?: ActionOptions): Promise<ActionResult[]>;
  getLogs(pcId: number): Promise<UiLogLine[]>;
  steamLogin(req: SteamLoginRequest): Promise<SteamLoginReply[]>;
  scan(): Promise<ScanHost[]>;
  exportAgentPackage(): Promise<{ ok: boolean; path?: string; error?: string }>;
  exportAgentZip(): Promise<{ ok: boolean; path?: string; error?: string }>;
  openDataDir(): Promise<void>;
  getSiteStatus(): Promise<SiteStatus>;
  /** Sends the current payload to url/token (may be unsaved values) and reports the HTTP result */
  testSite(url: string, token: string): Promise<SiteTestResult>;
  onSiteStatus(cb: (s: SiteStatus) => void): () => void;
  getQueueStatus(): Promise<QueueRunStatus | null>;
  startQueue(req: QueueStartRequest): Promise<{ ok: boolean; error?: string }>;
  cancelQueue(): Promise<void>;
  onQueueStatus(cb: (s: QueueRunStatus | null) => void): () => void;
  getBundledAgent(): Promise<AgentSource | null>;
  pickAgentFile(): Promise<AgentSource | null>;
  startAgentUpdate(req: AgentUpdateRequest): Promise<{ ok: boolean; error?: string }>;
  cancelAgentUpdate(): Promise<void>;
  getAgentUpdateStatus(): Promise<AgentUpdateStatus | null>;
  onAgentUpdateStatus(cb: (s: AgentUpdateStatus | null) => void): () => void;
  listGames(pcIds: number[]): Promise<PcGamesResult[]>;
  uninstallGame(pcId: number, appId: number, libraryPath: string): Promise<GamesUninstallResult>;
  installGame(pcId: number, appId: number, libraryPath?: string): Promise<GamesInstallResult>;
  diagProcesses(pcId: number): Promise<DiagProcess[]>;
  diagKillProcess(pcId: number, pid: number): Promise<DiagActionResult>;
  diagRestartExplorer(pcId: number): Promise<DiagActionResult>;
  diagScreenshot(pcId: number): Promise<DiagScreenshotResult>;
  diagNotify(pcId: number, args: DiagNotifyArgs): Promise<DiagActionResult>;
  diagRestoreRefreshRate(pcId: number, targetHz: number): Promise<DiagActionResult>;
  diagRestartLauncher(pcId: number, app: RestartLauncherApp): Promise<DiagActionResult>;
  exportDiagnosticsZip(pcId?: number): Promise<{ ok: boolean; path?: string; error?: string }>;
  exportBackup(): Promise<{ ok: boolean; path?: string; error?: string }>;
  importBackup(): Promise<BackupImportResult>;
  pickBackupDir(): Promise<string | null>;
  runAutoBackupNow(): Promise<{ ok: boolean; path?: string; error?: string }>;
  getBackupStatus(): Promise<BackupStatus>;
  pickDeployFile(): Promise<PickedDeployFile | null>;
  startDeployExec(req: DeployExecRequest): Promise<{ ok: boolean; error?: string }>;
  startDeployFile(req: DeployFileRequest): Promise<{ ok: boolean; error?: string }>;
  cancelDeploy(): Promise<void>;
  getDeployStatus(): Promise<DeployRunStatus | null>;
  onDeployStatus(cb: (s: DeployRunStatus | null) => void): () => void;
  getAppUpdateStatus(): Promise<AppUpdateState>;
  checkAppUpdates(): Promise<AppUpdateState>;
  installAppUpdate(): Promise<{ ok: boolean; error?: string }>;
  onAppUpdateStatus(cb: (s: AppUpdateState) => void): () => void;
  onRuntimes(cb: (runtimes: PcRuntime[]) => void): () => void;
  onLogs(cb: (batches: LogBatch[]) => void): () => void;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  onPcsChanged(cb: (pcs: PcRecord[]) => void): () => void;
  listHistory(): Promise<JobHistoryEntry[]>;
  onHistoryChanged(cb: (entries: JobHistoryEntry[]) => void): () => void;
}

export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  uiSetTheme: 'ui:set-theme',
  settingsRegenKey: 'settings:regen-key',
  pinSet: 'security:pin-set',
  pinVerify: 'security:pin-verify',
  roleGet: 'role:get',
  roleUnlock: 'role:unlock',
  roleLock: 'role:lock',
  roleSetOperator: 'role:set-operator',
  auditList: 'audit:list',
  auditLog: 'audit:log',
  pcsList: 'pcs:list',
  pcsSave: 'pcs:save',
  pcsDelete: 'pcs:delete',
  pcSetServiceNote: 'pcs:set-service-note',
  mapGet: 'map:get',
  mapSave: 'map:save',
  mapExport: 'map:export',
  mapImport: 'map:import',
  runtimesGet: 'rt:get',
  actionRun: 'action:run',
  logsGet: 'logs:get',
  steamLogin: 'steam:login',
  scan: 'net:scan',
  exportAgent: 'agent:export',
  exportAgentZip: 'agent:export-zip',
  openData: 'app:open-data',
  siteStatus: 'site:status',
  siteTest: 'site:test',
  queueStatus: 'queue:status',
  queueStart: 'queue:start',
  queueCancel: 'queue:cancel',
  agentBundled: 'agent-update:bundled',
  agentPick: 'agent-update:pick',
  agentUpdateStart: 'agent-update:start',
  agentUpdateCancel: 'agent-update:cancel',
  agentUpdateStatus: 'agent-update:status',
  gamesList: 'games:list',
  gamesUninstall: 'games:uninstall',
  gamesInstall: 'games:install',
  diagProcesses: 'diag:processes',
  diagKillProcess: 'diag:kill-process',
  diagRestartExplorer: 'diag:restart-explorer',
  diagScreenshot: 'diag:screenshot',
  diagNotify: 'diag:notify',
  diagRestoreRefreshRate: 'diag:restore-hz',
  diagRestartLauncher: 'diag:restart-launcher',
  diagExportZip: 'diag:export-zip',
  backupExport: 'backup:export',
  backupImport: 'backup:import',
  backupPickDir: 'backup:pick-dir',
  backupRunNow: 'backup:run-now',
  backupStatus: 'backup:status',
  deployPickFile: 'deploy:pick-file',
  deployExecStart: 'deploy:exec-start',
  deployFileStart: 'deploy:file-start',
  deployCancel: 'deploy:cancel',
  deployStatus: 'deploy:status',
  appUpdateStatus: 'app-update:status',
  appUpdateCheck: 'app-update:check',
  appUpdateInstall: 'app-update:install',
  // main -> renderer
  siteUpdate: 'site:update',
  queueUpdate: 'queue:update',
  agentUpdateUpdate: 'agent-update:update',
  deployUpdate: 'deploy:update',
  appUpdateChanged: 'app-update:changed',
  runtimesUpdate: 'rt:update',
  logsAppend: 'logs:append',
  scanProgress: 'scan:progress',
  pcsChanged: 'pcs:changed',
  historyList: 'history:list',
  historyUpdate: 'history:update',
  roleChanged: 'role:changed',
  auditUpdate: 'audit:update',
} as const;
