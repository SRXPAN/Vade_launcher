import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AFTER_ACTION_TITLES,
  DEFAULT_CLEAN_LAUNCHERS,
  DEFAULT_DETECTOR,
  DEFAULT_POST_SESSION_CLEAN,
  ERR_BUSY,
  ERR_NOT_SERVICE,
  ERR_OCCUPIED,
  OCCUPANCY_REASON_TITLES,
  PROTOCOL_VERSION,
  type AgentConfigPayload,
  type DetectorSettings,
  type PostSessionCleanSettings,
  type QuickCleanResult,
  type AgentInfo,
  type AgentState,
  type AgentStatus,
  type JobMode,
  type PendingPower,
  type PowerAction,
  type SteamLoginResult,
} from '@vade/protocol';
import { runQuickClean } from './jobs/quickClean';
import { JobRunner } from './jobs/runner';
import type { Logger } from './logger';
import { OccupancyDetector } from './occupancy/detector';
import { PostSessionWatcher } from './occupancy/postSession';
import { PresenceReporter, type PresenceMode } from './occupancy/presence';
import { downloadVerified, installedServicePaths, launchUpdateHelper, updateHelperScript } from './update/selfUpdate';
import { ensureDefenderExclusions } from './win/defender';
import { DiskMonitor } from './win/disks';
import { HealthMonitor } from './win/health';
import { syncWindowsTime } from './win/time';
import { AgentScheduler } from './scheduler';
import { classifySteamLogin, ensureSteamcmd, GUARD_PROMPT_RE, runSteamcmd } from './steam/steamcmd';
import type { AgentStore } from './store';
import type { Sys } from './sys';
import { AGENT_VERSION, AgentError, errMsg } from './util';
import { isLink, removeLinkOnly } from './win/junction';
import { applyPowerPolicy, executePower } from './win/power';
import { syncWakeTask } from './win/wakeTask';

const POWER_TITLES: Record<PowerAction, string> = {
  sleep: 'Сон',
  hibernate: 'Гібернація',
  shutdown: 'Вимкнення',
  restart: 'Перезавантаження',
};

export interface AgentDeps {
  sys: Sys;
  log: Logger;
  store: AgentStore;
  dataDir: string;
  /** How the player-session reporter runs. Default: scheduled task (service), own child process in dry-run. */
  presenceMode?: PresenceMode;
}

/** Older admin apps do not send the detector section. */
export function effectiveDetector(cfg: AgentConfigPayload | null): DetectorSettings {
  const d = cfg?.detector;
  if (!d || typeof d !== 'object') return DEFAULT_DETECTOR;
  return { ...DEFAULT_DETECTOR, ...d };
}

export function effectivePostSession(cfg: AgentConfigPayload | null): PostSessionCleanSettings {
  const p = cfg?.postSessionClean;
  if (!p || typeof p !== 'object') return DEFAULT_POST_SESSION_CLEAN;
  return {
    ...DEFAULT_POST_SESSION_CLEAN,
    ...p,
    cleanLaunchers: { ...DEFAULT_CLEAN_LAUNCHERS, ...(p.cleanLaunchers ?? {}) },
  };
}

/** Validates a config pushed by the admin app; returns an error text or null. */
export function validateConfigPayload(p: unknown): string | null {
  const c = p as AgentConfigPayload;
  if (!c || typeof c !== 'object' || typeof c.rev !== 'string') return 'немає rev';
  const m = c.maintenance;
  if (!m || typeof m !== 'object') return 'немає maintenance';
  for (const k of ['steamPath', 'steamcmdDir'] as const) {
    const v = m[k];
    if (typeof v !== 'string' || !path.win32.isAbsolute(v)) return `${k}: потрібен абсолютний шлях`;
    const parsed = path.win32.parse(path.win32.normalize(v));
    if (parsed.root.replace(/\\$/, '').toLowerCase() === path.win32.normalize(v).replace(/\\$/, '').toLowerCase()) {
      return `${k}: корінь диска не дозволено`;
    }
  }
  if (!m.update || !Array.isArray(m.update.appIds) || !m.update.appIds.every((x) => Number.isInteger(x) && x > 0)) return 'update.appIds';
  if (m.update.ignoreAppIds !== undefined && (!Array.isArray(m.update.ignoreAppIds) || !m.update.ignoreAppIds.every((x) => Number.isInteger(x) && x > 0))) {
    return 'update.ignoreAppIds';
  }
  if (!m.workshop || !Array.isArray(m.workshop.appIds) || !m.workshop.appIds.every((x) => Number.isInteger(x) && x > 0)) return 'workshop.appIds';
  if (m.extraUpdaters !== undefined) {
    const eu = m.extraUpdaters;
    if (!eu || typeof eu !== 'object' || !Array.isArray(eu.apps)) return 'extraUpdaters';
  }
  if (!m.after || !['none', 'sleep', 'hibernate', 'shutdown'].includes(m.after.action)) return 'after.action';
  if (!c.schedule || typeof c.schedule.runTime !== 'string') return 'schedule';
  if (c.detector !== undefined) {
    const d = c.detector;
    const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!d || typeof d !== 'object' || !strings(d.gameProcesses) || !strings(d.senetProcesses) || !strings(d.senetLockTitles)) return 'detector';
    if (typeof d.idleMinutes !== 'number' || d.idleMinutes <= 0) return 'detector.idleMinutes';
  }
  if (c.postSessionClean !== undefined) {
    const p = c.postSessionClean;
    const okBrowsers = Array.isArray(p?.browsers) && p.browsers.every((b) => ['chrome', 'edge', 'opera', 'firefox'].includes(b));
    if (!p || !Array.isArray(p.closeApps) || !p.closeApps.every((x) => typeof x === 'string') || !okBrowsers) return 'postSessionClean';
    if (typeof p.delaySec !== 'number' || p.delaySec < 0) return 'postSessionClean.delaySec';
  }
  return null;
}

/**
 * The agent core: owns the job runner, the local scheduler and pending power actions,
 * and exposes the current status. Emits 'status', 'log' and 'power.pending'.
 */
export class Agent extends EventEmitter {
  readonly runner: JobRunner;
  readonly scheduler: AgentScheduler;
  readonly detector: OccupancyDetector;
  readonly postSession: PostSessionWatcher;
  private readonly presence: PresenceReporter;
  private readonly disks: DiskMonitor;
  private readonly health: HealthMonitor;
  private quickCleanBusy = false;
  private quickCleanAt: string | null = null;
  private updating = false;
  private pendingPower: PendingPower | null = null;
  private powerTimer: NodeJS.Timeout | null = null;
  private powering = false;
  private loginBusy = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly d: AgentDeps) {
    super();
    this.runner = new JobRunner({
      sys: d.sys,
      log: d.log,
      dataDir: d.dataDir,
      getConfig: () => d.store.state.config,
      changed: () => this.changed(),
      finished: (job) => {
        d.store.state.lastJob = job;
        this.save();
      },
      schedulePower: (action, delaySec, reason) => this.schedulePower(action, delaySec, reason),
      steamcmdBusy: () => this.loginBusy,
    });
    this.scheduler = new AgentScheduler({
      getSchedule: () => d.store.state.config?.schedule ?? null,
      getLastKey: () => d.store.state.lastScheduledKey,
      setLastKey: (key) => {
        d.store.state.lastScheduledKey = key;
        this.save();
      },
      isBusy: () => this.isBusy(),
      startJob: (mode) => {
        try {
          this.runner.start(mode);
        } catch (e) {
          d.log.error(`Запуск за розкладом не вдався: ${errMsg(e)}`);
        }
      },
      log: (msg) => d.log.info(msg),
      blockReason: () => {
        const cfg = d.store.state.config;
        if (cfg?.maintenance.skipIfOccupied === false) return null;
        const s = this.detector.state;
        return s.occupancy === 'occupied' ? `${OCCUPANCY_REASON_TITLES[s.reason]}${s.detail ? `: ${s.detail}` : ''}` : null;
      },
    });
    const presenceDir = path.join(d.dataDir, 'presence');
    this.presence = new PresenceReporter(d.sys, d.log, presenceDir, d.presenceMode ?? (d.sys.dryRun ? 'child' : 'task'));
    this.postSession = new PostSessionWatcher({
      getSettings: () => effectivePostSession(d.store.state.config),
      getOccupancy: () => this.detector.state.occupancy,
      isBusy: () => this.isBusy(),
      run: async () => {
        await this.quickClean('auto', true);
      },
      log: (msg) => d.log.info(msg),
      onPending: (at) => {
        this.quickCleanAt = at;
        this.changed();
      },
    });
    this.detector = new OccupancyDetector({
      sys: d.sys,
      log: d.log,
      presenceDir,
      getSettings: () => effectiveDetector(d.store.state.config),
      onChange: () => this.changed(),
      onTransition: (prev, next) => this.postSession.onTransition(prev, next),
    });
    this.disks = new DiskMonitor(d.sys, () => this.changed());
    this.health = new HealthMonitor(d.sys, () => this.changed());
    d.log.on('line', (line) => this.emit('log', line));
  }

  /** Anything that must not overlap with a job, a quick clean or a self-update. */
  private isBusy(): boolean {
    return this.runner.isRunning() || this.loginBusy || this.powering || this.updating || this.quickCleanBusy;
  }

  get log(): Logger {
    return this.d.log;
  }

  async init(): Promise<void> {
    const { sys, log, store } = this.d;
    await sys.detectOemCodepage();
    void ensureDefenderExclusions(sys, log, store, AGENT_VERSION);
    await applyPowerPolicy(sys, log);
    // A crash in the middle of an update could leave the junction behind.
    const steamcmdDir = store.state.config?.maintenance.steamcmdDir ?? 'C:\\steamcmd';
    const slot = path.join(steamcmdDir, 'steamapps');
    if (!sys.dryRun && fs.existsSync(slot) && (await isLink(slot)) && (await removeLinkOnly(sys, slot))) {
      log.warn(`Видалено залишений junction ${slot}`);
    }
    await syncWakeTask(sys, log, store.state.config?.schedule ?? null);
    await this.presence.start();
    this.detector.start();
    this.disks.start();
    this.health.start();
    this.scheduler.start();
  }

  info(): AgentInfo {
    const nics: AgentInfo['nics'] = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal && a.mac !== '00:00:00:00:00:00') nics.push({ name, mac: a.mac.toLowerCase(), ip: a.address });
      }
    }
    return {
      protocol: PROTOCOL_VERSION,
      version: AGENT_VERSION,
      hostname: os.hostname(),
      nics,
      os: `${os.version()} (${os.release()})`,
      startedAt: this.startedAt,
    };
  }

  status(): AgentStatus {
    const cfg = this.d.store.state.config;
    let state: AgentState = 'idle';
    if (this.powering) state = 'powering';
    else if (this.runner.isRunning()) state = this.runner.phase() ?? 'cleaning';
    else if (this.loginBusy) state = 'steam-login';
    return {
      state,
      job: this.runner.current,
      lastJob: this.d.store.state.lastJob,
      nextRunAt: this.scheduler.nextRunAt(),
      pendingPower: this.pendingPower,
      configRev: cfg?.rev ?? null,
      steamcmdInstalled: fs.existsSync(path.join(cfg?.maintenance.steamcmdDir ?? 'C:\\steamcmd', 'steamcmd.exe')),
      dryRun: this.d.sys.dryRun,
      occupancy: this.detector.state.occupancy,
      occupancyReason: this.detector.state.reason,
      occupancyDetail: this.detector.state.detail,
      presence: this.detector.state.presence,
      disks: this.disks.disks,
      quickCleanAt: this.quickCleanAt,
      lastQuickClean: this.d.store.state.lastQuickClean ?? null,
      health: this.health.health,
      agentTimeMs: Date.now(),
    };
  }

  /** Coalesces bursts of changes into one 'status' event every 300 ms. */
  changed(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emit('status', this.status());
    }, 300);
  }

  private save(): void {
    try {
      this.d.store.saveState();
    } catch (e) {
      this.d.log.error(`Не вдалося зберегти state.json: ${errMsg(e)}`);
    }
  }

  async applyConfig(p: AgentConfigPayload): Promise<{ changed: boolean; nextRunAt: string | null }> {
    const err = validateConfigPayload(p);
    if (err) throw new Error(`Некоректні налаштування: ${err}`);
    const prev = this.d.store.state.config;
    if (prev?.rev === p.rev) return { changed: false, nextRunAt: this.scheduler.nextRunAt() };
    const s = p.schedule;
    const scheduleChanged =
      !prev ||
      prev.schedule.enabled !== s.enabled ||
      prev.schedule.runTime !== s.runTime ||
      prev.schedule.wakeLeadMin !== s.wakeLeadMin;
    this.d.store.state.config = p;
    if (scheduleChanged) {
      // A slot that is already in the past today must not fire right now.
      const past = AgentScheduler.pastSlotKey(s);
      if (past) this.d.store.state.lastScheduledKey = past;
    }
    this.save();
    this.d.log.info(
      `Отримано налаштування (rev ${p.rev}): ПК №${p.pcId}, розклад ${s.enabled ? s.runTime : 'вимкнено'}, після — ${AFTER_ACTION_TITLES[p.maintenance.after.action]}`,
    );
    if (scheduleChanged) await syncWakeTask(this.d.sys, this.d.log, s);
    this.changed();
    return { changed: true, nextRunAt: this.scheduler.nextRunAt() };
  }

  /**
   * Manual runs on an occupied PC are refused with code "occupied" so the admin app can warn;
   * force = true is the admin's explicit "run anyway".
   */
  startJob(mode: JobMode, force = false): string {
    if (this.powering) throw new Error('ПК вимикається');
    if (this.updating) throw new AgentError('Оновлюється агент', ERR_BUSY);
    if (this.quickCleanBusy) throw new AgentError('Виконується швидке очищення', ERR_BUSY);
    const s = this.detector.state;
    // Night runs (own timer or the admin's queue) respect skipIfOccupied; manual runs always ask first.
    const skipIfOccupied = this.d.store.state.config?.maintenance.skipIfOccupied !== false;
    if (!force && s.occupancy === 'occupied' && (mode !== 'scheduled' || skipIfOccupied)) {
      throw new AgentError(`ПК зайнятий гравцем: ${OCCUPANCY_REASON_TITLES[s.reason]}${s.detail ? ` (${s.detail})` : ''}`, ERR_OCCUPIED);
    }
    if (force && s.occupancy === 'occupied') this.d.log.warn(`Примусовий запуск на зайнятому ПК (${OCCUPANCY_REASON_TITLES[s.reason]})`);
    return this.runner.start(mode);
  }

  cancelJob(): boolean {
    return this.runner.cancel();
  }

  power(action: PowerAction, delaySec: number): PendingPower {
    return this.schedulePower(action, delaySec, 'команда адміністратора');
  }

  cancelPower(): boolean {
    if (!this.pendingPower || this.powering) return false;
    if (this.powerTimer) clearTimeout(this.powerTimer);
    this.powerTimer = null;
    this.d.log.warn(`${POWER_TITLES[this.pendingPower.action]} скасовано`);
    this.pendingPower = null;
    this.changed();
    return true;
  }

  private schedulePower(action: PowerAction, delaySec: number, reason: string): PendingPower {
    if (this.powering) throw new Error('ПК вже вимикається');
    if (this.powerTimer) clearTimeout(this.powerTimer);
    const delay = Math.max(0, Math.min(3600, Math.round(delaySec)));
    this.pendingPower = { action, at: new Date(Date.now() + delay * 1000).toISOString() };
    this.d.log.info(`${POWER_TITLES[action]} через ${delay} с (${reason})`);
    this.emit('power.pending', this.pendingPower);
    this.changed();
    this.powerTimer = setTimeout(() => void this.firePower(), delay * 1000);
    return this.pendingPower;
  }

  private async firePower(): Promise<void> {
    const p = this.pendingPower;
    this.powerTimer = null;
    if (!p) return;
    this.powering = true;
    this.changed();
    try {
      if (this.runner.isRunning()) {
        this.runner.cancel();
        await this.runner.waitIdle(30_000);
      }
      this.d.log.info(`${POWER_TITLES[p.action]}…`);
      await executePower(this.d.sys, p.action);
    } catch (e) {
      this.d.log.error(`${POWER_TITLES[p.action]}: ${errMsg(e)}`);
    } finally {
      // For sleep we get here after the PC wakes up again.
      this.powering = false;
      this.pendingPower = null;
      this.changed();
    }
  }

  /**
   * Interactive SteamCMD login as SYSTEM, so the cached credentials belong to the account
   * that runs the night updates. The password is used once and never stored.
   */
  async steamLogin(user: string, password: string, guardCode?: string): Promise<SteamLoginResult> {
    if (this.runner.isRunning()) throw new Error('Зараз виконується обслуговування');
    if (this.loginBusy) throw new Error('Вхід SteamCMD уже виконується');
    if (!/^[\w.@-]{2,64}$/.test(user)) throw new Error('Некоректний логін Steam');
    const cfg = this.d.store.state.config;
    if (!cfg) throw new Error('Агент ще не отримав налаштувань');
    if (this.d.sys.dryRun) return { outcome: 'error', message: 'dry-run: вхід SteamCMD не виконується' };

    this.loginBusy = true;
    this.changed();
    try {
      const exe = await ensureSteamcmd(this.d.sys, cfg.maintenance.steamcmdDir, undefined, (m) => this.d.log.info(m));
      if (!exe) return { outcome: 'error', message: 'SteamCMD не знайдено' };
      this.d.log.info(`Вхід SteamCMD: ${user}${guardCode ? ' (з кодом Steam Guard)' : ''}`);
      const args = ['+login', user, password, ...(guardCode ? [guardCode.trim()] : []), '+quit'];
      const res = await runSteamcmd(exe, args, {
        timeoutMs: 150_000,
        redact: [password],
        onLine: (line) => this.d.log.log('steam', line.trim()),
        // Without a code SteamCMD would wait on its prompt forever.
        shouldStop: (_out, partial) => GUARD_PROMPT_RE.test(partial),
      });
      const result = res.timedOut ? { outcome: 'timeout' as const, message: 'SteamCMD не відповів за 150 с' } : classifySteamLogin(res.output + (GUARD_PROMPT_RE.test(res.output) ? '\nSteam Guard' : ''));
      this.d.log.log(result.outcome === 'ok' ? 'info' : 'warn', `Вхід SteamCMD: ${result.message}`);
      return result;
    } finally {
      this.loginBusy = false;
      this.changed();
    }
  }

  /**
   * Post-session quick clean: close apps, Steam sign-in data, browser sessions (2–3 s).
   * Manual runs on an occupied PC are refused with "occupied" unless forced.
   */
  async quickClean(trigger: 'auto' | 'manual', force = false): Promise<QuickCleanResult> {
    if (this.isBusy()) throw new AgentError('Зараз виконується інше завдання', ERR_BUSY);
    const s = this.detector.state;
    if (!force && s.occupancy === 'occupied') {
      throw new AgentError(`ПК зайнятий гравцем: ${OCCUPANCY_REASON_TITLES[s.reason]}${s.detail ? ` (${s.detail})` : ''}`, ERR_OCCUPIED);
    }
    const cfg = this.d.store.state.config;
    const settings = effectivePostSession(cfg);
    this.quickCleanBusy = true;
    this.changed();
    this.d.log.info(trigger === 'auto' ? 'Швидке очищення після виходу клієнта…' : 'Швидке очищення логінів (команда адміністратора)…');
    try {
      const r = await runQuickClean({
        sys: this.d.sys,
        settings: { ...settings, enabled: true },
        steamPath: cfg?.maintenance.steamPath ?? 'C:\\Program Files (x86)\\Steam',
        log: (msg) => this.d.log.info(`  ${msg}`),
      });
      this.d.log.log(r.failed ? 'warn' : 'info', `Швидке очищення: ${r.summary}`);
      this.d.store.state.lastQuickClean = { at: new Date().toISOString(), trigger, ok: true, summary: r.summary };
      this.save();
      return r;
    } catch (e) {
      this.d.store.state.lastQuickClean = { at: new Date().toISOString(), trigger, ok: false, summary: errMsg(e) };
      this.save();
      throw e;
    } finally {
      this.quickCleanBusy = false;
      this.changed();
    }
  }

  /** Download, verify sha256 and hand over to the update helper. The service restarts afterwards. */
  async selfUpdate(args: { url: string; sha256: string; version: string }): Promise<{ message: string }> {
    if (this.d.sys.dryRun) throw new AgentError('dry-run: оновлення агента не виконується', ERR_NOT_SERVICE);
    const paths = installedServicePaths();
    if (!paths) throw new AgentError('Агент запущено не як служба VadeAgent — оновлення неможливе', ERR_NOT_SERVICE);
    if (this.isBusy()) throw new AgentError('Зараз виконується завдання — оновіть пізніше', ERR_BUSY);
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new Error('Некоректний url оновлення');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Некоректний url оновлення');
    if (!/^[\w.+-]{1,40}$/.test(args.version)) throw new Error('Некоректна версія');

    this.updating = true;
    this.changed();
    try {
      this.d.log.info(`Оновлення агента ${AGENT_VERSION} → ${args.version}: завантаження з ${url.host}`);
      const { bytes } = await downloadVerified(url.toString(), paths.newExe, args.sha256);
      this.d.log.info(`Завантажено ${(bytes / 1024 / 1024).toFixed(1)} МБ, sha256 збігся. Служба перезапуститься через кілька секунд`);
      await launchUpdateHelper(
        this.d.sys,
        updateHelperScript({ installDir: paths.installDir, dataDir: this.d.dataDir, fromVersion: AGENT_VERSION, toVersion: args.version }),
      );
      return { message: `Завантажено й перевірено; служба перезапускається на ${args.version}` };
    } catch (e) {
      this.updating = false;
      this.changed();
      this.d.log.error(`Оновлення агента скасовано: ${errMsg(e)}`);
      throw e;
    }
  }

  async syncTime(): Promise<{ ok: boolean; agentTimeMs: number; message: string }> {
    const res = await syncWindowsTime(this.d.sys, this.d.log);
    this.changed();
    return res;
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    this.detector.stop();
    this.presence.stop();
    this.postSession.stop();
    this.disks.stop();
    this.health.stop();
    if (this.runner.isRunning()) {
      this.runner.cancel();
      await this.runner.waitIdle(15_000);
    }
  }
}
