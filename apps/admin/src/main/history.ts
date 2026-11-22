/**
 * Persistent 14-day (configurable) maintenance job history stored in history.json.
 * Atomic writes (.tmp + .bak + rename) match AdminStore's safety guarantees.
 */
import fs from 'node:fs';
import type { JobHistoryEntry, JobState } from '@vade/protocol';

const DAY_MS = 86_400_000;

export interface ProblemPcSummary {
  pcId: number;
  errorCount: number;
  lastErrorAt: string;
  failedApps: string[];
}

function readJsonArray(file: string): JobHistoryEntry[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw) ? (raw as JobHistoryEntry[]) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

/** Filters out records older than `retentionDays` and keeps newest entries first. */
export function pruneHistory(entries: JobHistoryEntry[], retentionDays: number, nowMs = Date.now()): JobHistoryEntry[] {
  const days = Math.max(1, Math.round(retentionDays || 14));
  const cutoff = nowMs - days * DAY_MS;
  return entries
    .filter((e) => {
      const ts = Date.parse(e.finishedAt || e.startedAt);
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .sort((a, b) => Date.parse(b.finishedAt || b.startedAt) - Date.parse(a.finishedAt || a.startedAt));
}

/** Converts a completed JobState into a compact JobHistoryEntry; returns null for incomplete jobs. */
export function jobToHistoryEntry(pcId: number, job: JobState): JobHistoryEntry | null {
  if (!job.finishedAt || !job.result) return null;
  const startMs = Date.parse(job.startedAt);
  const endMs = Date.parse(job.finishedAt);
  const durationSec = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;
  const updatedApps = job.apps.filter((a) => a.status === 'ok').length;
  const errorApps = job.apps
    .filter((a) => a.status === 'error' || a.status === 'login_error')
    .map((a) => ({
      appId: a.appId,
      ...(a.name ? { name: a.name } : {}),
      status: a.status,
      ...(a.message ? { message: a.message } : {}),
    }));
  return {
    id: job.id,
    pcId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationSec,
    mode: job.mode,
    result: job.result,
    updatedApps,
    errorApps,
    errors: job.errors,
  };
}

/** Flags PCs with >= minErrors failed runs within the last `days` days. */
export function findProblemPcs(
  entries: JobHistoryEntry[],
  days = 7,
  minErrors = 2,
  nowMs = Date.now(),
): ProblemPcSummary[] {
  const cutoff = nowMs - Math.max(1, days) * DAY_MS;
  const map = new Map<number, { count: number; lastErrorAt: string; lastMs: number; apps: Set<string> }>();
  for (const e of entries) {
    if (e.result !== 'errors') continue;
    const ms = Date.parse(e.finishedAt || e.startedAt);
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    let bucket = map.get(e.pcId);
    if (!bucket) {
      bucket = { count: 0, lastErrorAt: e.finishedAt || e.startedAt, lastMs: ms, apps: new Set() };
      map.set(e.pcId, bucket);
    }
    bucket.count++;
    if (ms > bucket.lastMs) {
      bucket.lastMs = ms;
      bucket.lastErrorAt = e.finishedAt || e.startedAt;
    }
    for (const a of e.errorApps) bucket.apps.add(a.name ? `${a.name} (${a.appId})` : String(a.appId));
  }
  const out: ProblemPcSummary[] = [];
  for (const [pcId, b] of map) {
    if (b.count >= minErrors) {
      out.push({ pcId, errorCount: b.count, lastErrorAt: b.lastErrorAt, failedApps: [...b.apps] });
    }
  }
  return out.sort((a, b) => b.errorCount - a.errorCount || a.pcId - b.pcId);
}

export class HistoryStore {
  entries: JobHistoryEntry[] = [];

  constructor(
    readonly file: string,
    retentionDays = 14,
  ) {
    const raw = readJsonArray(file) ?? readJsonArray(`${file}.bak`) ?? [];
    this.entries = pruneHistory(raw, retentionDays);
    if (raw.length !== this.entries.length) writeJsonAtomic(this.file, this.entries);
  }

  record(pcId: number, job: JobState, retentionDays = 14): boolean {
    const entry = jobToHistoryEntry(pcId, job);
    if (!entry) return false;
    if (this.entries.some((e) => e.pcId === entry.pcId && e.id === entry.id)) return false;
    this.entries = pruneHistory([entry, ...this.entries], retentionDays);
    writeJsonAtomic(this.file, this.entries);
    return true;
  }

  prune(retentionDays: number): void {
    const next = pruneHistory(this.entries, retentionDays);
    if (next.length !== this.entries.length) {
      this.entries = next;
      writeJsonAtomic(this.file, this.entries);
    }
  }
}
