/**
 * Updates non-Steam clients (Riot Client, Epic Games Launcher, FACEIT AC, ...) by launching
 * them for at least `minWaitMin`, then polling network receive throughput every 15 s until
 * download speed stays below `idleKbps` for 60 consecutive seconds (or `maxWaitMin` expires).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Sys } from '../sys';
import { errMsg, sleep } from '../util';
import { EXE } from '../win/paths';
import type { StepCtx, StepOutcome } from './steps';

export interface NetworkIdleWaitOptions {
  minWaitMs: number;
  maxWaitMs: number;
  idleKbps: number;
  pollMs?: number;
  idleConfirmMs?: number;
  signal?: AbortSignal;
  readRxBytes: () => Promise<number | null>;
  nowFn?: () => number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onSample?: (kbps: number, elapsedMs: number) => void;
}

export interface NetworkIdleResult {
  reason: 'idle' | 'timeout' | 'aborted';
  elapsedMs: number;
  peakKbps: number;
}

/** Splits an argument string supporting quoted segments (`--flag="a b"`). */
export function splitArgs(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** Reads sum of ReceivedBytes across active Windows network adapters. */
export async function readTotalRxBytes(sys: Sys): Promise<number | null> {
  const r = await sys.powershell(
    '$s = (Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Measure-Object -Property ReceivedBytes -Sum).Sum; if ($null -ne $s) { [uint64]$s }',
    { mutating: false, timeoutMs: 10_000 },
  );
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pure, deterministic network-idle detector (injectable clock & sleep for unit tests).
 */
export async function waitForNetworkIdle(opts: NetworkIdleWaitOptions): Promise<NetworkIdleResult> {
  const nowFn = opts.nowFn ?? (() => Date.now());
  const sleepFn = opts.sleepFn ?? sleep;
  const pollMs = opts.pollMs ?? 15_000;
  const idleConfirmMs = opts.idleConfirmMs ?? 60_000;
  const startedAt = nowFn();
  let peakKbps = 0;

  if (opts.signal?.aborted) {
    return { reason: 'aborted', elapsedMs: 0, peakKbps: 0 };
  }

  const maxMs = Math.max(opts.minWaitMs, opts.maxWaitMs);
  if (opts.minWaitMs > 0) {
    await sleepFn(opts.minWaitMs, opts.signal);
    if (opts.signal?.aborted) {
      return { reason: 'aborted', elapsedMs: nowFn() - startedAt, peakKbps };
    }
  }

  let prevBytes = await opts.readRxBytes();
  let prevAt = nowFn();
  let idleSince: number | null = null;

  while (true) {
    const elapsed = nowFn() - startedAt;
    if (opts.signal?.aborted) return { reason: 'aborted', elapsedMs: elapsed, peakKbps };
    if (elapsed >= maxMs) return { reason: 'timeout', elapsedMs: elapsed, peakKbps };

    const stepMs = Math.min(pollMs, maxMs - elapsed);
    await sleepFn(stepMs, opts.signal);

    const now = nowFn();
    if (opts.signal?.aborted) return { reason: 'aborted', elapsedMs: now - startedAt, peakKbps };

    const curBytes = await opts.readRxBytes();
    const dtSec = Math.max(0.1, (now - prevAt) / 1000);
    let kbps = 0;
    if (curBytes != null && prevBytes != null && curBytes >= prevBytes) {
      kbps = (curBytes - prevBytes) / 1024 / dtSec;
    }
    if (kbps > peakKbps) peakKbps = kbps;
    opts.onSample?.(kbps, now - startedAt);

    if (kbps <= opts.idleKbps) {
      if (idleSince == null) idleSince = prevAt;
      if (now - idleSince >= idleConfirmMs) {
        return { reason: 'idle', elapsedMs: now - startedAt, peakKbps };
      }
    } else {
      idleSince = null;
    }

    prevBytes = curBytes;
    prevAt = now;
  }
}

export async function runExtraUpdaters(ctx: StepCtx): Promise<StepOutcome> {
  const cfg = ctx.cfg.extraUpdaters;
  const apps = (cfg?.apps ?? []).filter((a) => a.enabled);
  if (apps.length === 0) return { status: 'skipped', note: 'немає увімкнених клієнтів' };

  const minWaitMs = Math.max(0, cfg.minWaitMin) * 60_000;
  const maxWaitMs = Math.max(cfg.minWaitMin, cfg.maxWaitMin) * 60_000;
  let launched = 0;
  let skipped = 0;

  for (const app of apps) {
    if (ctx.signal.aborted) break;
    if (!app.exePath.trim() || !fs.existsSync(app.exePath)) {
      ctx.log(`  ${app.name}: не знайдено (${app.exePath}) — пропуск`);
      skipped++;
      continue;
    }
    launched++;
    if (ctx.sys.dryRun) {
      ctx.log(`  [dry-run] ${app.name}: запуск ${app.exePath} (очікування ${cfg.minWaitMin}..${cfg.maxWaitMin} хв, поріг ${cfg.idleKbps} КБ/с)`);
      continue;
    }

    ctx.log(`  ${app.name}: запуск оновлення (${path.basename(app.exePath)})`);
    let child: ChildProcess | null = null;
    try {
      child = spawn(app.exePath, splitArgs(app.args), {
        cwd: path.dirname(app.exePath),
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
      });
      child.on('error', (e) => ctx.log(`  ${app.name}: помилка запуску — ${errMsg(e)}`));

      const res = await waitForNetworkIdle({
        minWaitMs,
        maxWaitMs,
        idleKbps: cfg.idleKbps,
        signal: ctx.signal,
        readRxBytes: () => readTotalRxBytes(ctx.sys),
      });
      const mins = (res.elapsedMs / 60_000).toFixed(1);
      if (res.reason === 'idle') {
        ctx.log(`  ${app.name}: мережа в простої (${mins} хв, пік ${res.peakKbps.toFixed(0)} КБ/с) — завершено`);
      } else if (res.reason === 'timeout') {
        ctx.log(`  ${app.name}: вичерпано ліміт ${cfg.maxWaitMin} хв (пік ${res.peakKbps.toFixed(0)} КБ/с) — закриваємо`);
      }
    } finally {
      try {
        if (child && child.exitCode === null) child.kill();
      } catch {
        // ignore
      }
      await ctx.sys.mutate(EXE.taskkill, ['/f', '/t', '/im', path.basename(app.exePath)], 15_000);
    }
  }

  if (launched === 0) return { status: 'skipped', note: `клієнтів не знайдено (${skipped})` };
  return { status: 'ok', note: `оновлено ${launched}${skipped ? `, відсутніх ${skipped}` : ''}` };
}
