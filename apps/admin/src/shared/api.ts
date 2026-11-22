/** Contract between the renderer (window.vade) and the Electron main process. */
import type { AppSettings, JobMode, LogLine, PcRecord, PcRuntime, SteamLoginResult } from '@vade/protocol';
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
  | 'clean-logins';

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

export interface VadeApi {
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  regenerateClubKey(): Promise<AppSettings>;
  listPcs(): Promise<PcRecord[]>;
  savePc(pc: PcRecord, originalId: number | null): Promise<SavePcResult>;
  deletePcs(ids: number[]): Promise<PcRecord[]>;
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
  onRuntimes(cb: (runtimes: PcRuntime[]) => void): () => void;
  onLogs(cb: (batches: LogBatch[]) => void): () => void;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  onPcsChanged(cb: (pcs: PcRecord[]) => void): () => void;
}

export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsRegenKey: 'settings:regen-key',
  pcsList: 'pcs:list',
  pcsSave: 'pcs:save',
  pcsDelete: 'pcs:delete',
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
  // main -> renderer
  siteUpdate: 'site:update',
  queueUpdate: 'queue:update',
  agentUpdateUpdate: 'agent-update:update',
  runtimesUpdate: 'rt:update',
  logsAppend: 'logs:append',
  scanProgress: 'scan:progress',
  pcsChanged: 'pcs:changed',
} as const;
