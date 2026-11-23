import { EventEmitter } from 'node:events';
import os from 'node:os';
import {
  buildAgentConfig,
  isClockDrifted,
  normalizeMac,
  type AgentInfo,
  type AgentStatus,
  type DeployExecArgs,
  type DeployExecResult,
  type DeployFileArgs,
  type DeployFileResult,
  type DiagActionResult,
  type DiagBundleResult,
  type DiagNotifyArgs,
  type DiagProcess,
  type DiagScreenshotResult,
  type GamesInstallResult,
  type GamesUninstallResult,
  type JobHistoryEntry,
  type JobMode,
  type LogLevel,
  type PcRecord,
  type PcRuntime,
  type PowerAction,
  type RestartLauncherApp,
} from '@vade/protocol';
import type { ActionOptions, ActionResult, LogBatch, PcAction, PcGamesResult, SteamLoginReply, SteamLoginRequest, UiLogLine } from '../shared/api';
import { AgentLink } from './agentLink';
import type { AdminStore } from './store';
import { sendWol } from './wol';

const LOG_LIMIT = 2000;
const POWER_DELAY_SEC = 3;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface HubEvents {
  runtimes: [PcRuntime[]];
  logs: [LogBatch[]];
  pcsChanged: [PcRecord[]];
  historyChanged: [JobHistoryEntry[]];
}

/**
 * Keeps one AgentLink per PC, merges everything the agents report into PcRuntime
 * objects and per-PC log buffers, and executes admin actions.
 */
export class AgentHub extends EventEmitter<HubEvents> {
  private readonly links = new Map<number, AgentLink>();
  private readonly rt = new Map<number, PcRuntime>();
  private readonly logs = new Map<number, UiLogLine[]>();
  private readonly lastAgentTs = new Map<number, string>();
  private readonly expectSleep = new Set<number>();
  private readonly lastTimeSync = new Map<number, number>();
  private pendingLogs: LogBatch[] = [];
  private rtTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  /** Checks of pending waitFor() calls, run on every runtime change */
  private readonly waiters = new Set<() => void>();

  constructor(private readonly store: AdminStore) {
    super();
  }

  runtime(id: number): PcRuntime {
    let r = this.rt.get(id);
    if (!r) {
      r = { pcId: id, link: 'offline', info: null, status: null, sleeping: false, lastSeen: null, lastError: null, wolSentAt: null };
      this.rt.set(id, r);
    }
    return r;
  }

  runtimes(): PcRuntime[] {
    return this.store.pcs.map((p) => this.runtime(p.id));
  }

  getLogs(id: number): UiLogLine[] {
    return this.logs.get(id) ?? [];
  }

  /** Brings the set of links in line with pcs.json and the network/security settings. */
  sync(): void {
    const { pcs, settings } = this.store;
    const port = settings.network.agentPort;
    const key = settings.security.clubKey;
    for (const [id, link] of this.links) {
      const pc = pcs.find((p) => p.id === id);
      if (!pc || link.opts.host !== pc.ip || link.opts.port !== port || link.opts.clubKey !== key) {
        link.removeAllListeners();
        link.stop();
        this.links.delete(id);
        if (!pc) {
          this.rt.delete(id);
          this.logs.delete(id);
        } else Object.assign(this.runtime(id), { link: 'offline', lastError: null });
      }
    }
    for (const pc of pcs) {
      if (this.links.has(pc.id)) continue;
      const link = this.createLink(pc.id, pc.ip, port, key);
      this.links.set(pc.id, link);
      link.start();
    }
    this.pushRuntimes();
  }

  stopAll(): void {
    for (const l of this.links.values()) l.stop();
  }

  private createLink(id: number, host: string, port: number, clubKey: string): AgentLink {
    const link = new AgentLink({ host, port, clubKey, clientName: os.hostname() });
    link.on('link', (state) => {
      const r = this.runtime(id);
      const wasOnline = r.link === 'online';
      r.link = state;
      r.lastError = link.lastError;
      const now = new Date().toISOString();
      if (state === 'online') {
        r.sleeping = false;
        r.lastSeen = now;
      } else if (wasOnline) {
        r.lastSeen = now;
        if (r.status) r.status = { ...r.status, job: null, state: 'idle', pendingPower: null };
        if (this.expectSleep.delete(id)) {
          r.sleeping = true;
          this.adminLog(id, 'info', 'ПК перейшов у сон / гібернацію');
        } else this.adminLog(id, 'warn', `Зв'язок з агентом втрачено${link.lastError ? `: ${link.lastError}` : ''}`);
      } else if (state === 'auth-failed' || state === 'incompatible') {
        this.adminLog(id, 'error', link.lastError ?? 'Помилка автентифікації');
      }
      this.pushRuntimes();
    });
    link.on('hello', (info, status) => {
      const r = this.runtime(id);
      r.info = info;
      r.status = status;
      r.lastSeen = new Date().toISOString();
      this.adminLog(id, 'info', `Агент на зв'язку: ${info.hostname}, версія ${info.version}${status.dryRun ? ' (DRY-RUN)' : ''}`);
      this.checkMac(id, info);
      this.recordStatusJob(id, status);
      this.maybeAutoSyncTime(id, status, link);
      this.pushRuntimes();
      void this.afterHello(id, link);
    });
    link.on('status', (s) => {
      const r = this.runtime(id);
      r.status = s;
      r.lastSeen = new Date().toISOString();
      this.recordStatusJob(id, s);
      this.maybeAutoSyncTime(id, s, link);
      this.pushRuntimes();
    });
    link.on('log', (line) => this.appendAgentLines(id, [line]));
    link.on('power.pending', (p) => {
      if (p.action === 'sleep' || p.action === 'hibernate') this.expectSleep.add(id);
      else this.expectSleep.delete(id);
    });
    return link;
  }

  private recordStatusJob(id: number, s: AgentStatus): void {
    if (s.lastJob?.finishedAt && s.lastJob?.result && this.store.recordJobHistory(id, s.lastJob)) {
      this.emit('historyChanged', this.store.listHistory());
    }
  }

  private maybeAutoSyncTime(id: number, s: AgentStatus, link: AgentLink): void {
    if (!this.store.settings.schedule.autoSyncTime) return;
    if (!isClockDrifted(s.agentTimeMs)) return;
    const last = this.lastTimeSync.get(id) ?? 0;
    if (Date.now() - last < 3600_000) return;
    this.lastTimeSync.set(id, Date.now());
    this.adminLog(id, 'warn', 'Виявлено розбіжність годинника (> 2 хв) — автоматична синхронізація часу (NTP)…');
    void link
      .request('time.sync', {}, 35_000)
      .then((res) => {
        const r = this.runtime(id);
        if (r.status) r.status = { ...r.status, agentTimeMs: res.agentTimeMs };
        this.adminLog(id, res.ok ? 'info' : 'warn', `NTP: ${res.message}`);
        this.pushRuntimes();
      })
      .catch((e) => this.adminLog(id, 'warn', `NTP: ${errMsg(e)}`));
  }

  private async afterHello(id: number, link: AgentLink): Promise<void> {
    try {
      const history = await link.request('log.history', { limit: 300 });
      const last = this.lastAgentTs.get(id);
      this.appendAgentLines(id, last ? history.filter((l) => l.ts > last) : history);
    } catch {
      // history is a convenience
    }
    try {
      await this.pushConfig(id);
    } catch (e) {
      this.adminLog(id, 'error', `Не вдалося передати налаштування: ${errMsg(e)}`);
    }
  }

  /** Fill in / warn about the MAC address using what the agent reports for this IP. */
  private checkMac(id: number, info: AgentInfo): void {
    const pc = this.store.pcs.find((p) => p.id === id);
    if (!pc) return;
    const nic = info.nics.find((n) => n.ip === pc.ip) ?? (info.nics.length === 1 ? info.nics[0] : undefined);
    const reported = nic ? normalizeMac(nic.mac) : null;
    if (!reported || reported === pc.mac) return;
    if (!pc.mac) {
      this.store.setMac(id, reported);
      this.emit('pcsChanged', this.store.pcs);
      this.adminLog(id, 'info', `MAC-адресу заповнено з агента: ${reported}`);
    } else {
      this.adminLog(id, 'warn', `MAC у списку (${pc.mac}) відрізняється від MAC агента (${reported}). Wake-on-LAN може не спрацювати — перевірте картку ПК.`);
    }
  }

  async pushConfig(id: number): Promise<void> {
    const pc = this.store.pcs.find((p) => p.id === id);
    const link = this.links.get(id);
    if (!pc || !link || link.state !== 'online') return;
    const res = await link.request('config.apply', buildAgentConfig(this.store.settings, pc));
    if (res.changed) this.adminLog(id, 'info', 'Налаштування передано агенту');
  }

  /** After settings/PC edits: every online agent gets its new config. */
  pushConfigAll(): void {
    for (const pc of this.store.pcs) {
      void this.pushConfig(pc.id).catch((e) => this.adminLog(pc.id, 'error', `Налаштування не передано: ${errMsg(e)}`));
    }
  }

  async wake(id: number, reason: string): Promise<void> {
    const pc = this.store.pcs.find((p) => p.id === id);
    if (!pc) throw new Error('ПК не знайдено');
    const { broadcast, wolPort } = this.store.settings.network;
    await sendWol(pc.mac, broadcast, wolPort);
    const r = this.runtime(id);
    r.wolSentAt = new Date().toISOString();
    this.adminLog(id, 'info', `Wake-on-LAN → ${pc.mac} через ${broadcast}:${wolPort} (${reason})`);
    this.links.get(id)?.retrySoon(20_000);
    this.pushRuntimes();
  }

  /** Resolves true as soon as pred(runtime) holds, false on timeout or abort. */
  waitFor(id: number, pred: (rt: PcRuntime) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const check = () => {
        if (pred(this.runtime(id))) done(true);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return done(false);
      this.waiters.add(check);
      check();
    });
  }

  /** Starts a job and returns its id; errors keep the agent's code (e.g. "occupied"). */
  async startJob(id: number, mode: JobMode, force: boolean): Promise<string> {
    const link = this.onlineLink(id);
    await this.pushConfig(id);
    const r = await link.request('job.start', force ? { mode, force: true } : { mode });
    return r.jobId;
  }

  async selfUpdate(id: number, args: { url: string; sha256: string; version: string }): Promise<{ message: string }> {
    // Download of ~100 MB + hash check on the agent: give it time.
    return this.onlineLink(id).request('agent.selfUpdate', args, 15 * 60_000);
  }

  localAddressOf(id: number): string | null {
    return this.links.get(id)?.localAddress ?? null;
  }

  listGames(pcIds: number[]): Promise<PcGamesResult[]> {
    return Promise.all(
      pcIds.map(async (pcId): Promise<PcGamesResult> => {
        try {
          const games = await this.onlineLink(pcId).request('games.list', {}, 20_000);
          return { pcId, ok: true, games };
        } catch (e) {
          return { pcId, ok: false, games: [], error: errMsg(e) };
        }
      }),
    );
  }

  async uninstallGame(pcId: number, appId: number, libraryPath: string): Promise<GamesUninstallResult> {
    const res = await this.onlineLink(pcId).request('games.uninstall', { appId, libraryPath }, 180_000);
    this.adminLog(pcId, res.ok ? 'info' : 'warn', res.message);
    return res;
  }

  async installGame(pcId: number, appId: number, libraryPath?: string): Promise<GamesInstallResult> {
    this.adminLog(pcId, 'info', `Запуск інсталяції гри AppID ${appId} через SteamCMD…`);
    const res = await this.onlineLink(pcId).request('games.install', libraryPath ? { appId, libraryPath } : { appId }, 4 * 3600_000);
    this.adminLog(pcId, res.ok ? 'info' : 'error', `AppID ${appId}: ${res.message}`);
    return res;
  }

  diagProcesses(pcId: number): Promise<DiagProcess[]> {
    return this.onlineLink(pcId).request('diag.processes', {}, 25_000);
  }

  diagKillProcess(pcId: number, pid: number): Promise<DiagActionResult> {
    return this.onlineLink(pcId).request('diag.killProcess', { pid }, 15_000);
  }

  diagRestartExplorer(pcId: number): Promise<DiagActionResult> {
    return this.onlineLink(pcId).request('diag.restartExplorer', {}, 25_000);
  }

  diagScreenshot(pcId: number): Promise<DiagScreenshotResult> {
    return this.onlineLink(pcId).request('diag.screenshot', {}, 25_000);
  }

  diagNotify(pcId: number, args: DiagNotifyArgs): Promise<DiagActionResult> {
    return this.onlineLink(pcId).request('diag.notify', args, 15_000);
  }

  diagRestoreRefreshRate(pcId: number, targetHz: number): Promise<DiagActionResult> {
    return this.onlineLink(pcId).request('diag.restoreRefreshRate', { targetHz }, 20_000);
  }

  diagRestartLauncher(pcId: number, app: RestartLauncherApp): Promise<DiagActionResult> {
    return this.onlineLink(pcId).request('diag.restartLauncher', { app }, 25_000);
  }

  collectDiagBundle(pcId: number): Promise<DiagBundleResult> {
    return this.onlineLink(pcId).request('diag.bundle', {}, 30_000);
  }

  deployExec(pcId: number, args: DeployExecArgs): Promise<DeployExecResult> {
    const timeoutMs = (Math.max(1, Math.min(600, args.timeoutSec || 60)) + 30) * 1000;
    return this.onlineLink(pcId).request('deploy.exec', args, timeoutMs);
  }

  deployFile(pcId: number, args: DeployFileArgs): Promise<DeployFileResult> {
    return this.onlineLink(pcId).request('deploy.file', args, 15 * 60_000);
  }

  private onlineLink(id: number): AgentLink {
    const link = this.links.get(id);
    if (!link || link.state !== 'online') throw new Error("Агент не на зв'язку");
    return link;
  }

  async runAction(action: PcAction, ids: number[], opts: ActionOptions = {}): Promise<ActionResult[]> {
    return Promise.all(
      ids.map(async (id): Promise<ActionResult> => {
        try {
          return { pcId: id, ok: true, message: await this.runOne(action, id, opts.force === true) };
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          return { pcId: id, ok: false, message: errMsg(e), ...(typeof code === 'string' ? { code } : {}) };
        }
      }),
    );
  }

  private async runOne(action: PcAction, id: number, force: boolean): Promise<string> {
    switch (action) {
      case 'wake':
        await this.wake(id, 'вручну');
        return 'Magic Packet надіслано';
      case 'test':
      case 'run': {
        const link = this.onlineLink(id);
        await this.pushConfig(id);
        const mode = action === 'test' ? 'test' : 'manual';
        const r = await link.request('job.start', force ? { mode, force: true } : { mode });
        this.adminLog(
          id,
          force ? 'warn' : 'info',
          `${action === 'test' ? 'Запущено тестове обслуговування' : 'Запущено обслуговування'}${force ? ' (примусово, ПК був зайнятий)' : ''}`,
        );
        return `Завдання ${r.jobId} запущено`;
      }
      case 'cancel': {
        const r = await this.onlineLink(id).request('job.cancel', {});
        return r.cancelled ? 'Скасовано' : 'Немає активного завдання';
      }
      case 'sleep':
      case 'hibernate':
      case 'shutdown':
      case 'restart': {
        const p = await this.onlineLink(id).request('power', { action: action as PowerAction, delaySec: POWER_DELAY_SEC });
        if (action === 'sleep' || action === 'hibernate') this.expectSleep.add(id);
        this.adminLog(id, 'info', `Команда: ${action} о ${new Date(p.at).toLocaleTimeString('uk-UA')}`);
        return 'Команду надіслано';
      }
      case 'cancel-power': {
        const r = await this.onlineLink(id).request('power.cancel', {});
        this.expectSleep.delete(id);
        return r.cancelled ? 'Скасовано' : 'Немає запланованої дії';
      }
      case 'clean-logins': {
        const link = this.onlineLink(id);
        await this.pushConfig(id);
        const r = await link.request('session.clean', force ? { force: true } : {}, 120_000);
        this.adminLog(id, force ? 'warn' : 'info', `Очищено логіни${force ? ' (примусово, ПК був зайнятий)' : ''}: ${r.summary}`);
        return r.summary;
      }
      case 'sync-time': {
        const link = this.onlineLink(id);
        this.lastTimeSync.set(id, Date.now());
        const res = await link.request('time.sync', {}, 35_000);
        const rt = this.runtime(id);
        if (rt.status) rt.status = { ...rt.status, agentTimeMs: res.agentTimeMs };
        this.adminLog(id, res.ok ? 'info' : 'warn', `Синхронізація часу: ${res.message}`);
        this.pushRuntimes();
        if (!res.ok) throw new Error(res.message);
        return res.message;
      }
    }
  }

  /** One PC after another: parallel logins with one account trigger Steam rate limits. */
  async steamLogin(req: SteamLoginRequest): Promise<SteamLoginReply[]> {
    const out: SteamLoginReply[] = [];
    for (const id of req.pcIds) {
      try {
        const link = this.onlineLink(id);
        await this.pushConfig(id);
        const result = await link.request(
          'steam.login',
          { user: req.user, password: link.sealSecret(req.password), guardCode: req.guardCode || undefined },
          200_000,
        );
        out.push({ pcId: id, ok: result.outcome === 'ok', result });
      } catch (e) {
        out.push({ pcId: id, ok: false, error: errMsg(e) });
      }
    }
    return out;
  }

  adminLog(id: number, level: LogLevel, msg: string): void {
    this.append(id, [{ ts: new Date().toISOString(), level, msg, admin: true }]);
  }

  private appendAgentLines(id: number, lines: UiLogLine[]): void {
    if (!lines.length) return;
    this.lastAgentTs.set(id, lines[lines.length - 1].ts);
    this.append(id, lines);
  }

  private append(id: number, lines: UiLogLine[]): void {
    let buf = this.logs.get(id);
    if (!buf) {
      buf = [];
      this.logs.set(id, buf);
    }
    buf.push(...lines);
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
    this.pendingLogs.push({ pcId: id, lines });
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => {
        this.logTimer = null;
        const batches = this.pendingLogs;
        this.pendingLogs = [];
        this.emit('logs', batches);
      }, 250);
    }
  }

  private pushRuntimes(): void {
    for (const check of [...this.waiters]) check();
    if (this.rtTimer) return;
    this.rtTimer = setTimeout(() => {
      this.rtTimer = null;
      this.emit('runtimes', this.runtimes());
    }, 150);
  }
}
