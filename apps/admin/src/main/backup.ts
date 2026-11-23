/**
 * Full configuration & club key ZIP backup/restore and daily auto-backup scheduler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dialog, shell, type BrowserWindow } from 'electron';
import type { AppSettings, PcRecord } from '@vade/protocol';
import type { BackupStatus } from '../shared/api';
import { sanitizeMapLayout, type MapLayout } from '../shared/mapLayout';
import { readZipFile, writeZipFile, type ZipEntry } from './zip';

export interface BackupStoreLike {
  dir: string;
  settings: AppSettings;
  pcs: PcRecord[];
  mapLayout: MapLayout;
  settingsFile: string;
  pcsFile: string;
  mapFile: string;
  reloadFromDisk?: () => void;
}

export interface BackupManifest {
  format: 'vade-backup';
  version: 1;
  appVersion: string;
  createdAt: string;
  files: string[];
}

const BACKUP_FILE_RE = /^vade-backup-(\d{4}-\d{2}-\d{2})\.zip$/;
const DEFAULT_KEEP_COUNT = 7;
const INITIAL_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 3600_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseJsonEntry(entries: Map<string, Buffer>, name: string): { buf: Buffer; value: unknown } {
  const buf = entries.get(name);
  if (!buf) {
    throw new Error(`У резервній копії відсутній обов'язковий файл: ${name}`);
  }
  try {
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    return { buf, value: JSON.parse(text) as unknown };
  } catch (e) {
    throw new Error(`Пошкоджений JSON у файлі ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readFileOrJson(filePath: string, fallback: unknown): Buffer {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  } catch {
    // Fall back to in-memory snapshot if file is momentarily unreadable.
  }
  return Buffer.from(JSON.stringify(fallback, null, 2), 'utf8');
}

function writeAtomicWithBak(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

function uniquePreBackupDir(baseDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const root = path.join(baseDir, 'pre-import-backups');
  let candidate = path.join(root, `before-import-${stamp}`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `before-import-${stamp}-${n++}`);
  }
  return candidate;
}

/** Local calendar date formatted as YYYY-MM-DD (e.g. 2026-11-23). */
export function formatBackupDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Builds full (unredacted) backup ZIP entries including clubKey, pinHash, and site.token. */
export function buildBackupEntries(store: BackupStoreLike, appVersion: string, now = new Date()): ZipEntry[] {
  const packedFiles = ['settings.json', 'pcs.json', 'map_layout.json', 'club.key'];
  const manifest: BackupManifest = {
    format: 'vade-backup',
    version: 1,
    appVersion,
    createdAt: now.toISOString(),
    files: packedFiles,
  };
  const clubKey = String(store.settings.security?.clubKey ?? '').trim();

  return [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2), mtime: now },
    { name: 'settings.json', data: readFileOrJson(store.settingsFile, store.settings), mtime: now },
    { name: 'pcs.json', data: readFileOrJson(store.pcsFile, store.pcs), mtime: now },
    { name: 'map_layout.json', data: readFileOrJson(store.mapFile, store.mapLayout), mtime: now },
    { name: 'club.key', data: clubKey, mtime: now },
  ];
}

export async function writeBackupZip(
  destPath: string,
  store: BackupStoreLike,
  appVersion: string,
  now = new Date(),
): Promise<string> {
  await writeZipFile(destPath, buildBackupEntries(store, appVersion, now));
  return destPath;
}

export async function exportBackupDialog(
  win: BrowserWindow,
  store: BackupStoreLike,
  appVersion: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const pick = await dialog.showSaveDialog(win, {
      title: 'Експортувати резервну копію конфігурації (.zip)',
      defaultPath: `vade-backup-${formatBackupDay()}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false };
    await writeBackupZip(pick.filePath, store, appVersion);
    shell.showItemInFolder(pick.filePath);
    return { ok: true, path: pick.filePath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Validates every required file in the backup ZIP in memory before touching disk,
 * saves a pre-import safety copy, atomically restores files, and reloads the store.
 */
export async function validateAndImportBackupZip(
  zipPath: string,
  store: BackupStoreLike,
): Promise<{ preBackupDir: string; manifest: BackupManifest }> {
  const entries = await readZipFile(zipPath);

  // 1. Validate manifest.json
  const { value: rawManifest } = parseJsonEntry(entries, 'manifest.json');
  if (!isPlainObject(rawManifest) || rawManifest.format !== 'vade-backup' || rawManifest.version !== 1) {
    throw new Error('Невірний формат резервної копії (очікується vade-backup v1)');
  }
  const manifest: BackupManifest = {
    format: 'vade-backup',
    version: 1,
    appVersion: typeof rawManifest.appVersion === 'string' ? rawManifest.appVersion : 'unknown',
    createdAt: typeof rawManifest.createdAt === 'string' ? rawManifest.createdAt : '',
    files: Array.isArray(rawManifest.files)
      ? rawManifest.files.filter((x): x is string => typeof x === 'string')
      : [],
  };

  // 2. Validate settings.json + club.key consistency/fallback
  const { buf: settingsBuf, value: rawSettings } = parseJsonEntry(entries, 'settings.json');
  if (!isPlainObject(rawSettings) || !isPlainObject(rawSettings.network)) {
    throw new Error('Некоректний файл settings.json у резервній копії');
  }
  const clubKeyBuf = entries.get('club.key');
  const fileClubKey = clubKeyBuf ? clubKeyBuf.toString('utf8').replace(/^\uFEFF/, '').trim() : undefined;
  const secObj = isPlainObject(rawSettings.security) ? { ...rawSettings.security } : {};
  const settingsClubKey = typeof secObj.clubKey === 'string' ? secObj.clubKey.trim() : '';

  if (fileClubKey !== undefined) {
    if (!fileClubKey) {
      throw new Error('Порожній файл club.key у резервній копії');
    }
    if (settingsClubKey && settingsClubKey !== fileClubKey) {
      throw new Error('Невідповідність ключа клубу між settings.json та club.key');
    }
  }

  const effectiveClubKey = settingsClubKey || fileClubKey || '';
  if (effectiveClubKey.length < 16) {
    throw new Error('Ключ клубу (security.clubKey) у резервній копії відсутній або закороткий (< 16 символів)');
  }

  let restoredSettingsBuf = settingsBuf;
  if (settingsClubKey !== effectiveClubKey) {
    secObj.clubKey = effectiveClubKey;
    rawSettings.security = secObj;
    restoredSettingsBuf = Buffer.from(JSON.stringify(rawSettings, null, 2), 'utf8');
  }

  // 3. Validate pcs.json
  const { buf: pcsBuf, value: rawPcs } = parseJsonEntry(entries, 'pcs.json');
  if (!Array.isArray(rawPcs)) {
    throw new Error('Некоректний файл pcs.json у резервній копії (очікується масив)');
  }
  const seenIds = new Set<number>();
  for (const item of rawPcs) {
    if (!isPlainObject(item) || typeof item.id !== 'number' || !Number.isInteger(item.id) || item.id <= 0) {
      throw new Error('Некоректний запис ПК у pcs.json (потрібен додатний цілий id)');
    }
    if (seenIds.has(item.id)) {
      throw new Error(`Дублікат id ПК (${item.id}) у pcs.json`);
    }
    seenIds.add(item.id);
  }

  // 4. Validate map_layout.json
  const { value: rawMap } = parseJsonEntry(entries, 'map_layout.json');
  const sanitizedMap = sanitizeMapLayout(rawMap);
  const restoredMapBuf = Buffer.from(JSON.stringify(sanitizedMap, null, 2), 'utf8');

  // 5. All checks passed: snapshot current files before overwriting
  const preBackupDir = uniquePreBackupDir(store.dir, new Date());
  fs.mkdirSync(preBackupDir, { recursive: true });
  for (const src of [store.settingsFile, store.pcsFile, store.mapFile]) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(preBackupDir, path.basename(src)));
    }
    const bak = `${src}.bak`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, path.join(preBackupDir, path.basename(bak)));
    }
  }

  // 6. Atomically restore validated configuration files
  writeAtomicWithBak(store.settingsFile, restoredSettingsBuf);
  writeAtomicWithBak(store.pcsFile, pcsBuf);
  writeAtomicWithBak(store.mapFile, restoredMapBuf);

  if ('reloadFromDisk' in store && typeof store.reloadFromDisk === 'function') {
    store.reloadFromDisk();
  }

  return { preBackupDir, manifest };
}

export async function importBackupDialog(
  win: BrowserWindow,
  store: BackupStoreLike,
): Promise<{ ok: boolean; canceled?: boolean; path?: string; preBackupDir?: string; error?: string }> {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Імпортувати резервну копію конфігурації (.zip)',
    properties: ['openFile'],
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  const zipPath = pick.filePaths[0];
  try {
    const { preBackupDir } = await validateAndImportBackupZip(zipPath, store);
    return { ok: true, path: zipPath, preBackupDir };
  } catch (e) {
    return { ok: false, path: zipPath, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Keeps newest `keepCount` daily backup archives and deletes older matching ZIPs. */
export function rotateAutoBackups(dir: string, keepCount = DEFAULT_KEEP_COUNT): string[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const keep = Math.max(1, Math.floor(Number.isFinite(keepCount) ? keepCount : DEFAULT_KEEP_COUNT));
  const matching = fs
    .readdirSync(dir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .sort((a, b) => b.localeCompare(a));

  const removed: string[] = [];
  for (const name of matching.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // Skip locked files so other obsolete archives can still be pruned.
    }
  }
  return removed;
}

/** Runs one daily auto-backup pass; skips existing today archive unless `opts.force` is true. */
export async function runAutoBackupOnce(
  store: BackupStoreLike,
  appVersion: string,
  opts?: { force?: boolean; now?: Date },
): Promise<{ ran: boolean; path?: string; removed: string[]; error?: string }> {
  const cfg = store.settings.backup;
  const dir = (cfg?.dir ?? '').trim();
  const force = opts?.force === true;

  if (!force && !cfg?.autoEnabled) {
    return { ran: false, removed: [] };
  }
  if (!dir) {
    return {
      ran: false,
      removed: [],
      ...(force ? { error: 'Не вказано папку для резервного копіювання' } : {}),
    };
  }

  const now = opts?.now ?? new Date();
  const keepCount = cfg?.keepCount || DEFAULT_KEEP_COUNT;
  const targetPath = path.join(dir, `vade-backup-${formatBackupDay(now)}.zip`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!force && fs.existsSync(targetPath)) {
      const removed = rotateAutoBackups(dir, keepCount);
      return { ran: false, removed };
    }

    await writeBackupZip(targetPath, store, appVersion, now);
    const removed = rotateAutoBackups(dir, keepCount);
    const iso = now.toISOString();
    if (store.settings.backup) {
      store.settings.backup.lastAutoBackupAt = iso;
    }
    return { ran: true, path: targetPath, removed };
  } catch (e) {
    return { ran: false, removed: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Schedules daily config backups in the background and exposes status/manual trigger controls. */
export class AutoBackupScheduler {
  private startTimer: NodeJS.Timeout | null = null;
  private hourlyTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError: string | null = null;
  private lastAutoBackupAt: string | null;

  constructor(
    private readonly store: BackupStoreLike,
    private readonly appVersion: string,
    private readonly onSaved?: (iso: string) => void,
  ) {
    this.lastAutoBackupAt = store.settings.backup?.lastAutoBackupAt ?? null;
  }

  start(): void {
    this.stop();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.tick();
    }, INITIAL_DELAY_MS);
    this.startTimer.unref?.();

    this.hourlyTimer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.hourlyTimer.unref?.();
  }

  reconfigure(): void {
    const b = this.store.settings.backup;
    if (b?.autoEnabled && b.dir.trim()) {
      void this.tick();
    } else if (!b?.autoEnabled) {
      this.lastError = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await runAutoBackupOnce(this.store, this.appVersion);
      if (res.error) {
        this.lastError = res.error;
      } else if (res.ran) {
        this.lastError = null;
        const iso = this.store.settings.backup?.lastAutoBackupAt ?? new Date().toISOString();
        this.lastAutoBackupAt = iso;
        this.onSaved?.(iso);
      } else {
        this.lastError = null;
      }
    } finally {
      this.busy = false;
    }
  }

  async runNow(): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (this.busy) {
      return { ok: false, error: 'Резервне копіювання вже виконується' };
    }
    this.busy = true;
    try {
      const res = await runAutoBackupOnce(this.store, this.appVersion, { force: true });
      if (res.error || !res.ran || !res.path) {
        const error = res.error ?? 'Не вдалося створити резервну копію';
        this.lastError = error;
        return { ok: false, error };
      }
      this.lastError = null;
      const iso = this.store.settings.backup?.lastAutoBackupAt ?? new Date().toISOString();
      this.lastAutoBackupAt = iso;
      this.onSaved?.(iso);
      return { ok: true, path: res.path };
    } finally {
      this.busy = false;
    }
  }

  status(): BackupStatus {
    const b = this.store.settings.backup;
    return {
      autoEnabled: b?.autoEnabled === true,
      dir: b?.dir ?? '',
      keepCount: b?.keepCount || DEFAULT_KEEP_COUNT,
      lastAutoBackupAt: b?.lastAutoBackupAt ?? this.lastAutoBackupAt,
      lastError: this.lastError,
    };
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.hourlyTimer) clearInterval(this.hourlyTimer);
    this.startTimer = null;
    this.hourlyTimer = null;
  }
}
