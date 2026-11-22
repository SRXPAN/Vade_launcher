import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AFTER_ACTION_TITLES,
  STEP_TITLES,
  type AgentConfigPayload,
  type AppResult,
  type AppUpdateStatus,
  type JobMode,
  type JobState,
  type LogLevel,
  type MaintenanceConfig,
  type PowerAction,
  type StepId,
} from '@vade/protocol';
import type { Logger } from '../logger';
import { findLibraries, installedApps, type InstalledApp } from '../steam/libraries';
import {
  classifyApp,
  detectLoginError,
  ensureSteamcmd,
  parseAppResultLine,
  parseProgress,
  runSteamcmd,
} from '../steam/steamcmd';
import type { Sys } from '../sys';
import { errMsg, fmtBytes, shortId } from '../util';
import { AwakeGuard } from '../win/awake';
import { createJunction, freeLinkSlot, removeLinkOnly } from '../win/junction';
import {
  cleanSteamCache,
  cleanSteamLogins,
  cleanTemp,
  cleanUserdata,
  cleanWorkshop,
  closeSteam,
  type StepCtx,
  type StepOutcome,
} from './steps';
import { runExtraUpdaters } from './extraUpdaters';

const JOB_TIMEOUT_MS = 8 * 3600_000; // same limit as the old scheduled task
const STEAMCMD_TIMEOUT_MS = 6 * 3600_000;

const MODE_TITLES: Record<JobMode, string> = {
  test: 'тестовий запуск (без вимкнення)',
  manual: 'ручний запуск',
  scheduled: 'нічне обслуговування за розкладом',
};

export interface SteamcmdOps {
  ensureSteamcmd: typeof ensureSteamcmd;
  runSteamcmd: typeof runSteamcmd;
  freeLinkSlot: typeof freeLinkSlot;
  createJunction: typeof createJunction;
  removeLinkOnly: typeof removeLinkOnly;
}

export interface RunnerDeps {
  sys: Sys;
  log: Logger;
  dataDir: string;
  getConfig(): AgentConfigPayload | null;
  changed(): void;
  finished(job: JobState): void;
  schedulePower(action: PowerAction, delaySec: number, reason: string): void;
  steamcmdBusy(): boolean;
  /** Optional override for tests (defaults to real SteamCMD & NTFS junctions). */
  steamcmdOps?: Partial<SteamcmdOps>;
}

/** Splits library games into those sent to SteamCMD and those skipped via ignoreAppIds (in auto mode). */
export function partitionLibraryApps(
  installed: InstalledApp[],
  update: MaintenanceConfig['update'],
): { toUpdate: InstalledApp[]; ignored: InstalledApp[] } {
  if (update.mode === 'list') {
    const wanted = new Set(update.appIds);
    return { toUpdate: installed.filter((a) => wanted.has(a.appId)), ignored: [] };
  }
  const ignoreSet = new Set(update.ignoreAppIds ?? []);
  const toUpdate: InstalledApp[] = [];
  const ignored: InstalledApp[] = [];
  for (const app of installed) {
    if (ignoreSet.has(app.appId)) ignored.push(app);
    else toUpdate.push(app);
  }
  return { toUpdate, ignored };
}

/** Whether a game's final status should increment job.errors and mark the job as failed. */
export function isAppErrorStatus(status: AppUpdateStatus, treatNoSubscriptionAsError: boolean): boolean {
  if (status === 'error' || status === 'login_error') return true;
  if (status === 'skipped_no_subscription') return treatNoSubscriptionAsError;
  return false;
}

export function planSteps(m: MaintenanceConfig, mode: JobMode): StepId[] {
  const steps: StepId[] = ['closeSteam'];
  if (m.cleanTemp) steps.push('cleanTemp');
  if (m.cleanSteamLogins) steps.push('steamLogins');
  if (m.cleanSteamCache) steps.push('steamCache');
  if (m.cleanUserdata) steps.push('userdata');
  if (m.workshop.enabled) steps.push('workshop');
  if (m.update.enabled) steps.push('update');
  if (m.extraUpdaters?.enabled) steps.push('extraUpdaters');
  if (mode !== 'test' && m.after.action !== 'none') steps.push('after');
  return steps;
}

export class JobRunner {
  current: JobState | null = null;
  private ac: AbortController | null = null;
  private running: Promise<void> | null = null;
  private lastProgressLog = new Map<number, number>();

  constructor(private readonly d: RunnerDeps) {}

  isRunning(): boolean {
    return this.current != null;
  }

  /** 'updating' while SteamCMD works, 'cleaning' for every other step. */
  phase(): 'cleaning' | 'updating' | null {
    if (!this.current) return null;
    const step = this.current.steps.find((s) => s.status === 'running');
    return step?.id === 'update' ? 'updating' : 'cleaning';
  }

  start(mode: JobMode): string {
    if (this.current) throw new Error('Обслуговування вже виконується');
    if (this.d.steamcmdBusy()) throw new Error('Зараз виконується вхід SteamCMD');
    const cfg = this.d.getConfig();
    if (!cfg) throw new Error('Агент ще не отримав налаштувань від адмін-панелі');
    const m = cfg.maintenance;
    const job: JobState = {
      id: shortId(),
      mode,
      startedAt: new Date().toISOString(),
      steps: planSteps(m, mode).map((id) => ({ id, status: 'pending' })),
      apps: [],
      progress: null,
      errors: 0,
    };
    this.current = job;
    this.lastProgressLog.clear();
    const ac = new AbortController();
    this.ac = ac;
    const timeout = setTimeout(() => {
      this.d.log.error('Перевищено ліміт часу 8 год — завдання зупинено', job.id);
      ac.abort();
    }, JOB_TIMEOUT_MS);
    this.running = this.execute(job, m, ac.signal)
      .catch((e) => {
        job.errors++;
        this.d.log.error(`Неочікувана помилка: ${errMsg(e)}`, job.id);
      })
      .finally(() => {
        clearTimeout(timeout);
        this.finish(job, m, ac.signal.aborted);
      });
    this.d.changed();
    return job.id;
  }

  cancel(): boolean {
    if (!this.current || !this.ac) return false;
    this.d.log.warn('Скасування завдання…', this.current.id);
    this.ac.abort();
    return true;
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    await Promise.race([this.running, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /* ---------------------------------------------------------------- */

  private async execute(job: JobState, m: MaintenanceConfig, signal: AbortSignal): Promise<void> {
    const L = (level: LogLevel, msg: string) => this.d.log.log(level, msg, job.id);
    L('info', `===== СТАРТ: ${MODE_TITLES[job.mode]} =====`);
    if (this.d.sys.dryRun) L('warn', 'DRY-RUN: нічого не видаляється і не змінюється, лише перевірка');

    const awake = new AwakeGuard(this.d.sys, this.d.log);
    awake.start();
    try {
      const steamExe = path.join(m.steamPath, 'steam.exe');
      const steamFound = fs.existsSync(steamExe);
      if (!steamFound) L('error', `Steam не знайдено: ${steamExe}`);
      const libraries = steamFound ? findLibraries(m.steamPath) : [];
      if (steamFound) L('info', `Бібліотеки Steam: ${libraries.join(', ') || '—'}`);

      const ctx: StepCtx = { sys: this.d.sys, cfg: m, signal, log: (msg) => L('info', msg) };
      const steam = (fn: () => Promise<StepOutcome>) => (): Promise<StepOutcome> =>
        steamFound ? fn() : Promise.resolve({ status: 'error', note: 'Steam не знайдено' });

      await this.step(job, 'closeSteam', signal, () => closeSteam(ctx));
      await this.step(job, 'cleanTemp', signal, () => cleanTemp(ctx));
      await this.step(job, 'steamLogins', signal, steam(() => cleanSteamLogins(ctx)));
      await this.step(job, 'steamCache', signal, steam(() => cleanSteamCache(ctx)));
      await this.step(job, 'userdata', signal, steam(() => cleanUserdata(ctx)));
      await this.step(job, 'workshop', signal, steam(() => cleanWorkshop(ctx, libraries)));
      await this.step(job, 'update', signal, steam(() => this.updateGames(job, m, libraries, signal, L)));
      await this.step(job, 'extraUpdaters', signal, () => runExtraUpdaters(ctx));
    } finally {
      awake.stop();
    }
  }

  private async step(job: JobState, id: StepId, signal: AbortSignal, fn: () => Promise<StepOutcome>): Promise<void> {
    const st = job.steps.find((s) => s.id === id);
    if (!st) return;
    if (signal.aborted) {
      st.status = 'skipped';
      st.note = 'скасовано';
      return;
    }
    const n = job.steps.indexOf(st) + 1;
    this.d.log.info(`[${n}/${job.steps.length}] ${STEP_TITLES[id]}`, job.id);
    st.status = 'running';
    this.d.changed();
    try {
      const r = await fn();
      st.status = r.status ?? 'ok';
      if (r.note) st.note = r.note;
      if (st.status === 'error') job.errors += r.errors ?? 1;
      else if (r.errors) job.errors += r.errors;
      if (r.note) this.d.log.log(st.status === 'error' ? 'error' : 'info', `  ${STEP_TITLES[id]}: ${r.note}`, job.id);
    } catch (e) {
      if (signal.aborted) {
        st.status = 'skipped';
        st.note = 'скасовано';
      } else {
        st.status = 'error';
        st.note = errMsg(e);
        job.errors++;
        this.d.log.error(`  ${STEP_TITLES[id]}: ПОМИЛКА — ${errMsg(e)}`, job.id);
      }
    }
    this.d.changed();
  }

  /** SteamCMD updates games IN PLACE through a temporary junction <steamcmd>\steamapps -> <library>\steamapps. */
  private async updateGames(
    job: JobState,
    m: MaintenanceConfig,
    libraries: string[],
    signal: AbortSignal,
    L: (level: LogLevel, msg: string) => void,
  ): Promise<StepOutcome> {
    const { sys } = this.d;
    const u = m.update;
    if (!u.steamUser.trim()) return { status: 'error', note: 'не вказано логін Steam' };
    if (u.mode === 'list' && u.appIds.length === 0) return { status: 'skipped', note: 'список AppID порожній' };

    const ops: SteamcmdOps = {
      ensureSteamcmd,
      runSteamcmd,
      freeLinkSlot,
      createJunction,
      removeLinkOnly,
      ...this.d.steamcmdOps,
    };

    const exe = await ops.ensureSteamcmd(sys, m.steamcmdDir, signal, (msg) => L('info', `  ${msg}`));
    if (!exe) {
      return sys.dryRun
        ? { status: 'skipped', note: 'dry-run: SteamCMD відсутній' }
        : { status: 'error', note: 'SteamCMD не знайдено і не вдалося завантажити' };
    }

    const slot = path.join(m.steamcmdDir, 'steamapps');
    const rawFile = path.join(this.d.dataDir, 'steamcmd-last.txt');
    await fsp.writeFile(rawFile, '').catch(() => undefined);
    const wanted = u.mode === 'list' ? new Set(u.appIds) : null;
    const treatNoSubAsError = u.treatNoSubscriptionAsError === true;
    const found = new Set<number>();
    let errors = 0;

    for (const lib of libraries) {
      if (signal.aborted) break;
      const { toUpdate: apps, ignored } = partitionLibraryApps(installedApps(lib), u);
      if (apps.length === 0 && ignored.length === 0) continue;
      apps.forEach((a) => found.add(a.appId));
      L('info', `  Бібліотека: ${lib}`);
      if (ignored.length > 0) {
        L('info', `  Пропущено (ігнор): ${ignored.map((a) => (a.name ? `${a.appId} (${a.name})` : a.appId)).join(', ')}`);
        job.apps.push(
          ...ignored.map<AppResult>((a) => ({
            appId: a.appId,
            name: a.name,
            library: lib,
            status: 'ignored',
            message: 'у списку винятків',
          })),
        );
      }
      if (apps.length === 0) {
        this.d.changed();
        continue;
      }
      L('info', `  Ігри: ${apps.map((a) => (a.name ? `${a.appId} (${a.name})` : a.appId)).join(', ')}`);
      const batch: AppResult[] = apps.map((a) => ({ appId: a.appId, name: a.name, library: lib, status: 'pending' }));
      job.apps.push(...batch);
      this.d.changed();

      if (sys.dryRun) {
        L('info', `  [dry-run] mklink /J "${slot}" "${path.join(lib, 'steamapps')}" + steamcmd +app_update …`);
        batch.forEach((b) => (b.message = 'dry-run: не оновлювалось'));
        continue;
      }

      if (!(await ops.freeLinkSlot(sys, slot))) {
        L('error', `  ПОМИЛКА: ${slot} зайнятий і не може бути звільнений`);
        batch.forEach((b) => Object.assign(b, { status: 'error', message: 'steamcmd\\steamapps зайнятий' }));
        errors += batch.length;
        continue;
      }
      try {
        await ops.createJunction(sys, slot, path.join(lib, 'steamapps'));
      } catch (e) {
        L('error', `  ПОМИЛКА: не вдалося створити junction на ${lib}\\steamapps: ${errMsg(e)}`);
        batch.forEach((b) => Object.assign(b, { status: 'error', message: 'junction не створено' }));
        errors += batch.length;
        continue;
      }

      let output = '';
      try {
        const args = ['+@NoPromptForPassword', '1', '+login', u.steamUser];
        for (const b of batch) args.push('+app_update', String(b.appId), ...(u.validate ? ['validate'] : []));
        args.push('+quit');
        const res = await ops.runSteamcmd(exe, args, {
          signal,
          timeoutMs: STEAMCMD_TIMEOUT_MS,
          rawFile,
          onLine: (line) => this.onSteamLine(job, batch, line, L),
        });
        output = res.output;
        if (res.timedOut) L('error', '  SteamCMD перевищив ліміт часу і був зупинений');
      } finally {
        // Always remove the link; the game files stay where they are.
        if (!(await ops.removeLinkOnly(sys, slot))) L('error', `  УВАГА: не вдалося видалити тимчасовий junction ${slot}`);
      }
      job.progress = null;

      const loginError = detectLoginError(output);
      if (loginError) L('error', `  LOGIN ERROR — ${loginError}. Виконайте «Вхід SteamCMD» для цього ПК в адмін-панелі.`);
      for (const b of batch) {
        if (b.status === 'pending' || b.status === 'updating') {
          if (signal.aborted) {
            b.status = 'error';
            b.message = 'скасовано';
            continue;
          }
          const c = classifyApp(output, b.appId, !!loginError);
          b.status = c.status;
          b.message = c.message;
        }
        const label = b.name ? `${b.appId} ${b.name}` : String(b.appId);
        if (b.status === 'ok') L('info', `  ${label}: OK${b.message ? ` (${b.message})` : ''}`);
        else if (b.status === 'skipped_no_subscription') {
          L(treatNoSubAsError ? 'error' : 'warn', `  ${label}: Skipped - No subscription${b.message ? ` (${b.message})` : ''}`);
        } else if (b.status === 'login_error') L('error', `  ${label}: LOGIN ERROR`);
        else L('error', `  ${label}: ERROR — ${b.message ?? ''}`);
        if (isAppErrorStatus(b.status, treatNoSubAsError)) errors++;
      }
      this.d.changed();
    }

    if (wanted) for (const id of wanted) if (!found.has(id)) L('warn', `  ${id}: не встановлено на цьому ПК — пропущено`);
    if (job.apps.length === 0) return { note: 'немає ігор для оновлення' };
    const ok = job.apps.filter((a) => a.status === 'ok').length;
    const ignoredCount = job.apps.filter((a) => a.status === 'ignored').length;
    const noSubCount = job.apps.filter((a) => a.status === 'skipped_no_subscription').length;
    const parts = [`OK ${ok} з ${job.apps.length}`];
    if (ignoredCount) parts.push(`ігнор ${ignoredCount}`);
    if (noSubCount) parts.push(`без ліцензії ${noSubCount}`);
    if (errors) parts.push(`помилок ${errors}`);
    return { status: errors ? 'error' : 'ok', errors, note: parts.join(', ') };
  }

  private onSteamLine(job: JobState, batch: AppResult[], line: string, L: (level: LogLevel, msg: string) => void): void {
    const p = parseProgress(line);
    if (p) {
      const cur = batch.find((b) => b.status === 'pending' || b.status === 'updating');
      if (!cur) return;
      cur.status = 'updating';
      job.progress = { appId: cur.appId, pct: p.pct, phase: p.phase, doneBytes: p.done, totalBytes: p.total };
      const bucket = Math.floor(p.pct / 10);
      if (this.lastProgressLog.get(cur.appId) !== bucket) {
        this.lastProgressLog.set(cur.appId, bucket);
        L('steam', `  ${cur.appId}: ${p.phase} ${p.pct.toFixed(1)}% (${fmtBytes(p.done)} / ${fmtBytes(p.total)})`);
      }
      this.d.changed();
      return;
    }
    const r = parseAppResultLine(line);
    if (r) {
      const b = batch.find((x) => x.appId === r.appId);
      if (b) {
        b.status = r.status;
        b.message = r.message;
        this.d.changed();
      }
    }
    L('steam', line.trim());
  }

  private finish(job: JobState, m: MaintenanceConfig, aborted: boolean): void {
    job.finishedAt = new Date().toISOString();
    job.progress = null;
    job.result = aborted ? 'cancelled' : job.errors > 0 ? 'errors' : 'ok';
    for (const s of job.steps) {
      if (s.status === 'pending' && s.id !== 'after') {
        s.status = 'skipped';
        s.note = aborted ? 'скасовано' : s.note;
      }
    }
    const after = job.steps.find((s) => s.id === 'after');
    const doPower = !!after && !aborted;
    if (after) {
      after.status = doPower ? 'ok' : 'skipped';
      after.note = doPower ? `${AFTER_ACTION_TITLES[m.after.action]} через ${m.after.delaySec} с` : 'скасовано';
    }
    if (job.result === 'ok') this.d.log.info('RESULT: OK', job.id);
    else if (job.result === 'cancelled') this.d.log.warn('RESULT: скасовано', job.id);
    else this.d.log.error(`RESULT: помилок ${job.errors} — див. рядки вище`, job.id);
    if (job.mode === 'test') this.d.log.info('Тестовий запуск — ПК залишається увімкненим', job.id);
    this.d.log.info('===== КІНЕЦЬ =====', job.id);

    this.current = null;
    this.ac = null;
    this.d.finished(job);
    this.d.changed();
    if (doPower && m.after.action !== 'none') {
      this.d.schedulePower(m.after.action, m.after.delaySec, 'завершення обслуговування');
    }
  }
}
