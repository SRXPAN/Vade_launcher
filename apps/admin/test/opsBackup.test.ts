import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type PcRecord } from '@vade/protocol';
import {
  AutoBackupScheduler,
  formatBackupDay,
  rotateAutoBackups,
  runAutoBackupOnce,
  validateAndImportBackupZip,
  writeBackupZip,
  type BackupStoreLike,
} from '../src/main/backup';
import { AdminStore } from '../src/main/store';
import { createZipBuffer, readZipBuffer, readZipFile, writeZipFile } from '../src/main/zip';
import { defaultMapLayout, type MapLayout } from '../src/shared/mapLayout';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-ops-backup-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function createBackupStore(dir: string, clubKey = 'club-secret-key-0123456789abcdef'): BackupStoreLike & { reloads: number } {
  const admin = new AdminStore(dir);
  const s = structuredClone(admin.settings);
  s.security.clubKey = clubKey;
  s.security.pinHash = 'saltabcd:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  s.site.token = 'site-bearer-token-secret';
  admin.settings = s;
  fs.writeFileSync(admin.settingsFile, JSON.stringify(s, null, 2));

  const pcs: PcRecord[] = [
    { id: 1, ip: '10.70.4.101', mac: '30:56:0f:3e:93:88', zone: 'Regular', name: 'PC-01' },
    { id: 2, ip: '10.70.4.102', mac: '30:56:0f:3e:91:0a', zone: 'VIP' },
  ];
  admin.pcs = pcs;
  fs.writeFileSync(admin.pcsFile, JSON.stringify(pcs, null, 2));

  const mapLayout: MapLayout = {
    ...defaultMapLayout(),
    labels: [{ id: 'vip-1', text: 'VIP Lounge', x: 5, y: 5, zone: 'VIP' }],
  };
  admin.saveMapLayout(mapLayout);

  return {
    dir: admin.dir,
    settings: admin.settings,
    pcs: admin.pcs,
    mapLayout: admin.mapLayout,
    settingsFile: admin.settingsFile,
    pcsFile: admin.pcsFile,
    mapFile: admin.mapFile,
    reloads: 0,
    reloadFromDisk() {
      this.reloads++;
      const reloaded = new AdminStore(this.dir);
      this.settings = reloaded.settings;
      this.pcs = reloaded.pcs;
      this.mapLayout = reloaded.mapLayout;
    },
  };
}

function replaceAsciiInBuffer(buf: Buffer, needle: string, replacement: string): Buffer {
  if (needle.length !== replacement.length) throw new Error('Lengths must match');
  const copy = Buffer.from(buf);
  let idx = copy.indexOf(needle, 0, 'utf8');
  while (idx !== -1) {
    copy.write(replacement, idx, 'utf8');
    idx = copy.indexOf(needle, idx + replacement.length, 'utf8');
  }
  return copy;
}

describe('Module 4: Pure-Node ZIP reader (readZipBuffer / readZipFile)', () => {
  it('roundtrips STORE, DEFLATE, and UTF-8 entries cleanly', async () => {
    const zipPath = path.join(tmp, 'roundtrip.zip');
    const bigText = 'Vade Launcher club config data — кіберклуб! '.repeat(25);
    const rawBin = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);

    await writeZipFile(zipPath, [
      { name: 'manifest.json', data: JSON.stringify({ ok: true }) },
      { name: 'nested/інструкція-uk.txt', data: bigText },
      { name: 'bin/stored.bin', data: rawBin, store: true },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]);

    const fromBuf = readZipBuffer(fs.readFileSync(zipPath));
    expect(JSON.parse(fromBuf.get('manifest.json')!.toString('utf8'))).toEqual({ ok: true });
    expect(fromBuf.get('nested/інструкція-uk.txt')!.toString('utf8')).toBe(bigText);
    expect(fromBuf.get('bin/stored.bin')!.equals(rawBin)).toBe(true);
    expect(fromBuf.get('empty.txt')!.length).toBe(0);

    const fromFile = await readZipFile(zipPath);
    expect([...fromFile.keys()]).toEqual([...fromBuf.keys()]);
  });

  it('rejects corrupt CRC32 payloads', () => {
    const buf = createZipBuffer([{ name: 'data.txt', data: 'hello world', store: true }]);
    // Flip a byte inside the stored payload just after the 30-byte header + 8-byte filename
    const tampered = Buffer.from(buf);
    tampered[38] ^= 0xff;
    expect(() => readZipBuffer(tampered)).toThrow(/CRC32/i);
  });

  it('rejects zip-slip path traversal, leading slash, and drive-letter entry names', () => {
    const traversal = createZipBuffer([{ name: '../evil.txt', data: 'bad' }]);
    expect(() => readZipBuffer(traversal)).toThrow(/Unsafe ZIP entry/i);

    const nestedTraversal = createZipBuffer([{ name: 'sub/../../evil.txt', data: 'bad' }]);
    expect(() => readZipBuffer(nestedTraversal)).toThrow(/Unsafe ZIP entry/i);

    const base = createZipBuffer([{ name: 'XXXX/evil.txt', data: 'bad' }]);
    expect(() => readZipBuffer(replaceAsciiInBuffer(base, 'XXXX', '/abs'))).toThrow(/Unsafe ZIP entry/i);
    expect(() => readZipBuffer(replaceAsciiInBuffer(base, 'XXXX', 'C:/x'))).toThrow(/Unsafe ZIP entry/i);
  });
});

describe('Module 4: Full Config & Key ZIP Backup and Import', () => {
  it('exports full unredacted backup ZIP and restores identically with pre-import safety copy', async () => {
    const srcStore = createBackupStore(path.join(tmp, 'src-data'), 'original-club-key-9876543210abcdef');
    const zipPath = path.join(tmp, 'club-backup.zip');
    const fixedNow = new Date(2026, 10, 23, 14, 5, 0);

    await writeBackupZip(zipPath, srcStore, '0.5.0', fixedNow);
    const entries = await readZipFile(zipPath);
    expect([...entries.keys()].sort()).toEqual(['club.key', 'manifest.json', 'map_layout.json', 'pcs.json', 'settings.json']);

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({
      format: 'vade-backup',
      version: 1,
      appVersion: '0.5.0',
      createdAt: fixedNow.toISOString(),
    });
    expect(entries.get('club.key')!.toString('utf8')).toBe('original-club-key-9876543210abcdef');
    const exportedSettings = JSON.parse(entries.get('settings.json')!.toString('utf8'));
    expect(exportedSettings.security.clubKey).toBe('original-club-key-9876543210abcdef');
    expect(exportedSettings.security.pinHash).toBe(srcStore.settings.security.pinHash);
    expect(exportedSettings.site.token).toBe('site-bearer-token-secret');

    // Target store currently has completely different clubKey, pcs, and map
    const dstStore = createBackupStore(path.join(tmp, 'dst-data'), 'different-old-club-key-000011112222');
    const priorSettingsRaw = fs.readFileSync(dstStore.settingsFile, 'utf8');
    const priorPcsRaw = fs.readFileSync(dstStore.pcsFile, 'utf8');
    const priorMapRaw = fs.readFileSync(dstStore.mapFile, 'utf8');
    dstStore.pcs = [{ id: 99, ip: '10.70.4.250', mac: 'aa:bb:cc:dd:ee:ff', zone: 'Old' }];
    fs.writeFileSync(dstStore.pcsFile, JSON.stringify(dstStore.pcs, null, 2));

    const res = await validateAndImportBackupZip(zipPath, dstStore);
    expect(res.manifest.format).toBe('vade-backup');
    expect(dstStore.reloads).toBe(1);

    // Restored files match source store identically
    expect(JSON.parse(fs.readFileSync(dstStore.settingsFile, 'utf8'))).toEqual(srcStore.settings);
    expect(JSON.parse(fs.readFileSync(dstStore.pcsFile, 'utf8'))).toEqual(srcStore.pcs);
    expect(JSON.parse(fs.readFileSync(dstStore.mapFile, 'utf8'))).toEqual(srcStore.mapLayout);
    expect(dstStore.settings.security.clubKey).toBe('original-club-key-9876543210abcdef');
    expect(dstStore.settings.security.pinHash).toBe(srcStore.settings.security.pinHash);
    expect(dstStore.settings.site.token).toBe('site-bearer-token-secret');

    // Pre-import safety backup contains previous files
    expect(res.preBackupDir).toContain(`${path.sep}pre-import-backups${path.sep}before-import-`);
    expect(fs.readFileSync(path.join(res.preBackupDir, 'settings.json'), 'utf8')).toBe(priorSettingsRaw);
    expect(JSON.parse(fs.readFileSync(path.join(res.preBackupDir, 'pcs.json'), 'utf8'))).toEqual([
      { id: 99, ip: '10.70.4.250', mac: 'aa:bb:cc:dd:ee:ff', zone: 'Old' },
    ]);
    expect(fs.readFileSync(path.join(res.preBackupDir, 'map_layout.json'), 'utf8')).toBe(priorMapRaw);
    expect(priorPcsRaw).toBeTruthy();
  });

  it('rejects invalid or tampered backup ZIPs without touching files on disk', async () => {
    const store = createBackupStore(path.join(tmp, 'safe-data'), 'keep-existing-key-1234567890abcdef');
    const beforeSettings = fs.readFileSync(store.settingsFile, 'utf8');
    const beforePcs = fs.readFileSync(store.pcsFile, 'utf8');
    const beforeMap = fs.readFileSync(store.mapFile, 'utf8');

    const badFormatZip = path.join(tmp, 'bad-format.zip');
    await writeZipFile(badFormatZip, [
      { name: 'manifest.json', data: JSON.stringify({ format: 'wrong', version: 1 }) },
      { name: 'settings.json', data: beforeSettings },
      { name: 'pcs.json', data: beforePcs },
      { name: 'map_layout.json', data: beforeMap },
    ]);
    await expect(validateAndImportBackupZip(badFormatZip, store)).rejects.toThrow(/vade-backup/);

    const keyMismatchZip = path.join(tmp, 'key-mismatch.zip');
    await writeZipFile(keyMismatchZip, [
      { name: 'manifest.json', data: JSON.stringify({ format: 'vade-backup', version: 1, appVersion: '0.5.0', createdAt: new Date().toISOString(), files: [] }) },
      { name: 'settings.json', data: JSON.stringify(defaultSettings('valid-key-in-settings-1234567890')) },
      { name: 'club.key', data: 'different-key-in-file-1234567890' },
      { name: 'pcs.json', data: beforePcs },
      { name: 'map_layout.json', data: beforeMap },
    ]);
    await expect(validateAndImportBackupZip(keyMismatchZip, store)).rejects.toThrow(/club\.key/);

    const badPcsZip = path.join(tmp, 'bad-pcs.zip');
    await writeZipFile(badPcsZip, [
      { name: 'manifest.json', data: JSON.stringify({ format: 'vade-backup', version: 1, appVersion: '0.5.0', createdAt: new Date().toISOString(), files: [] }) },
      { name: 'settings.json', data: beforeSettings },
      { name: 'pcs.json', data: JSON.stringify([{ id: -5, ip: '10.70.4.1', mac: 'aa:bb:cc:dd:ee:ff', zone: 'Regular' }]) },
      { name: 'map_layout.json', data: beforeMap },
    ]);
    await expect(validateAndImportBackupZip(badPcsZip, store)).rejects.toThrow(/pcs\.json/);

    expect(store.reloads).toBe(0);
    expect(fs.existsSync(path.join(store.dir, 'pre-import-backups'))).toBe(false);
    expect(fs.readFileSync(store.settingsFile, 'utf8')).toBe(beforeSettings);
    expect(fs.readFileSync(store.pcsFile, 'utf8')).toBe(beforePcs);
    expect(fs.readFileSync(store.mapFile, 'utf8')).toBe(beforeMap);
  });
});

describe('Module 4: Daily auto-backup & retention rotation', () => {
  it('writes vade-backup-YYYY-MM-DD.zip once per day unless forced and rotates oldest archives', async () => {
    const store = createBackupStore(path.join(tmp, 'auto-store'));
    const backupDir = path.join(tmp, 'backups');
    store.settings.backup = { autoEnabled: true, dir: backupDir, keepCount: 7 };

    // Pre-populate 9 previous days + unrelated file
    fs.mkdirSync(backupDir, { recursive: true });
    for (let day = 11; day <= 19; day++) {
      fs.writeFileSync(path.join(backupDir, `vade-backup-2026-11-${String(day).padStart(2, '0')}.zip`), 'stub');
    }
    fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'keep me');

    const today = new Date(2026, 10, 20, 9, 30, 0);
    expect(formatBackupDay(today)).toBe('2026-11-20');

    const first = await runAutoBackupOnce(store, '0.5.0', { now: today });
    expect(first.ran).toBe(true);
    expect(first.path).toBe(path.join(backupDir, 'vade-backup-2026-11-20.zip'));
    expect(first.removed.sort()).toEqual([
      'vade-backup-2026-11-11.zip',
      'vade-backup-2026-11-12.zip',
      'vade-backup-2026-11-13.zip',
    ]);
    expect(store.settings.backup.lastAutoBackupAt).toBe(today.toISOString());

    const remainingZips = fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.zip'))
      .sort();
    expect(remainingZips).toEqual([
      'vade-backup-2026-11-14.zip',
      'vade-backup-2026-11-15.zip',
      'vade-backup-2026-11-16.zip',
      'vade-backup-2026-11-17.zip',
      'vade-backup-2026-11-18.zip',
      'vade-backup-2026-11-19.zip',
      'vade-backup-2026-11-20.zip',
    ]);
    expect(fs.existsSync(path.join(backupDir, 'notes.txt'))).toBe(true);

    // Same day without force -> does not overwrite
    const initialBytes = fs.readFileSync(first.path!);
    const second = await runAutoBackupOnce(store, '0.5.0', { now: new Date(2026, 10, 20, 18, 0, 0) });
    expect(second).toEqual({ ran: false, removed: [] });
    expect(fs.readFileSync(first.path!).equals(initialBytes)).toBe(true);

    // Same day with force -> overwrites archive cleanly
    const third = await runAutoBackupOnce(store, '0.5.0', { force: true, now: new Date(2026, 10, 20, 19, 0, 0) });
    expect(third.ran).toBe(true);
    expect(store.settings.backup.lastAutoBackupAt).toBe(new Date(2026, 10, 20, 19, 0, 0).toISOString());

    // Direct rotateAutoBackups check
    expect(rotateAutoBackups(backupDir, 3).sort()).toEqual([
      'vade-backup-2026-11-14.zip',
      'vade-backup-2026-11-15.zip',
      'vade-backup-2026-11-16.zip',
      'vade-backup-2026-11-17.zip',
    ]);
  });

  it('AutoBackupScheduler runs on demand and exposes status cleanly', async () => {
    const store = createBackupStore(path.join(tmp, 'sched-store'));
    const backupDir = path.join(tmp, 'sched-backups');
    store.settings.backup = { autoEnabled: false, dir: backupDir, keepCount: 5 };

    const savedAt: string[] = [];
    const scheduler = new AutoBackupScheduler(store, '0.5.0', (iso) => savedAt.push(iso));
    expect(scheduler.status()).toEqual({
      autoEnabled: false,
      dir: backupDir,
      keepCount: 5,
      lastAutoBackupAt: null,
      lastError: null,
    });

    const manual = await scheduler.runNow();
    expect(manual.ok).toBe(true);
    expect(manual.path).toBe(path.join(backupDir, `vade-backup-${formatBackupDay()}.zip`));
    expect(savedAt).toHaveLength(1);
    expect(scheduler.status().lastAutoBackupAt).toBe(savedAt[0]);
    expect(scheduler.status().lastError).toBeNull();
    scheduler.stop();
  });

  it('restores missing security.clubKey from club.key entry and triggers scheduled backups via fake timers', async () => {
    const store = createBackupStore(path.join(tmp, 'fallback-store'), 'existing-key-1111222233334444');
    const settingsMissingKey = defaultSettings('');
    const zipPath = path.join(tmp, 'clubkey-fallback.zip');
    await writeZipFile(zipPath, [
      {
        name: 'manifest.json',
        data: JSON.stringify({ format: 'vade-backup', version: 1, appVersion: '0.5.0', createdAt: new Date().toISOString(), files: [] }),
      },
      { name: 'settings.json', data: JSON.stringify(settingsMissingKey) },
      { name: 'club.key', data: 'recovered-from-club-key-file-9999' },
      { name: 'pcs.json', data: JSON.stringify(store.pcs) },
      { name: 'map_layout.json', data: JSON.stringify(store.mapLayout) },
    ]);

    await validateAndImportBackupZip(zipPath, store);
    expect(store.settings.security.clubKey).toBe('recovered-from-club-key-file-9999');

    vi.useFakeTimers();
    const autoDir = path.join(tmp, 'fake-timer-backups');
    store.settings.backup = { autoEnabled: true, dir: autoDir, keepCount: 7 };
    const savedAt: string[] = [];
    let resolveSaved!: () => void;
    const savedPromise = new Promise<void>((r) => {
      resolveSaved = r;
    });
    const scheduler = new AutoBackupScheduler(store, '0.5.0', (iso) => {
      savedAt.push(iso);
      resolveSaved();
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await savedPromise;
    expect(savedAt).toHaveLength(1);
    expect(fs.existsSync(path.join(autoDir, `vade-backup-${formatBackupDay()}.zip`))).toBe(true);
    scheduler.stop();
  });
});
