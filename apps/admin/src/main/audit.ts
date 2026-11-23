/**
 * Persistent 30-day / 5000-entry Admin Audit Log stored in audit.json.
 * Uses atomic writes (.tmp + .bak + rename) matching HistoryStore and AdminStore.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AdminRole, AuditAction, AuditEntry } from '@vade/protocol';

const DAY_MS = 86_400_000;
const MAX_OPERATOR_NAME_LEN = 60;

export const AUDIT_RETENTION_DAYS = 30;
export const AUDIT_MAX_ENTRIES = 5000;

export interface RecordAuditInput {
  role: AdminRole;
  operatorName?: string;
  action: AuditAction;
  targets?: Array<string | number>;
  details?: string;
}

function readJsonArray(file: string): AuditEntry[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw) ? (raw as AuditEntry[]) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown, backupMain = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (backupMain && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

/**
 * Filters audit entries to those with valid timestamps within `retentionDays`,
 * sorts newest-first, and caps at `maxEntries`.
 */
export function pruneAudit(
  entries: AuditEntry[],
  retentionDays = AUDIT_RETENTION_DAYS,
  maxEntries = AUDIT_MAX_ENTRIES,
  nowMs = Date.now(),
): AuditEntry[] {
  const days = Math.max(1, Math.round(retentionDays || AUDIT_RETENTION_DAYS));
  const cap = Math.max(1, Math.round(maxEntries || AUDIT_MAX_ENTRIES));
  const cutoff = nowMs - days * DAY_MS;

  return entries
    .filter((e) => {
      if (!e || typeof e !== 'object' || typeof e.ts !== 'string') return false;
      const ms = Date.parse(e.ts);
      return Number.isFinite(ms) && ms >= cutoff;
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, cap);
}

/** Persistent store for administrative audit events. */
export class AuditStore extends EventEmitter<{ changed: [AuditEntry[]] }> {
  private entries: AuditEntry[] = [];

  constructor(
    readonly file: string,
    readonly retentionDays = AUDIT_RETENTION_DAYS,
    readonly maxEntries = AUDIT_MAX_ENTRIES,
  ) {
    super();
    const mainEntries = readJsonArray(file);
    const bakEntries = mainEntries === null ? readJsonArray(`${file}.bak`) : null;
    const raw = mainEntries ?? bakEntries ?? [];
    this.entries = pruneAudit(raw, retentionDays, maxEntries);

    if (mainEntries === null && bakEntries !== null) {
      // Heal corrupt main file from .bak without overwriting .bak with the corrupt main file.
      writeJsonAtomic(this.file, this.entries, false);
    } else if (raw.length !== this.entries.length) {
      writeJsonAtomic(this.file, this.entries);
    }
  }

  /** Returns a shallow copy of current audit entries (newest first). */
  list(): AuditEntry[] {
    return [...this.entries];
  }

  /** Appends an audit entry, prunes by retention & cap, persists atomically, and emits 'changed'. */
  record(input: RecordAuditInput, nowMs = Date.now()): AuditEntry {
    const cleanOperator = input.operatorName?.trim().slice(0, MAX_OPERATOR_NAME_LEN);
    const cleanDetails = input.details?.trim();
    const entry: AuditEntry = {
      id: randomUUID(),
      ts: new Date(nowMs).toISOString(),
      role: input.role,
      ...(cleanOperator ? { operatorName: cleanOperator } : {}),
      action: input.action,
      targets: (input.targets ?? []).map((t) => String(t)),
      ...(cleanDetails ? { details: cleanDetails } : {}),
    };

    this.entries = pruneAudit([entry, ...this.entries], this.retentionDays, this.maxEntries, nowMs);
    writeJsonAtomic(this.file, this.entries);
    this.emit('changed', this.list());
    return entry;
  }
}
