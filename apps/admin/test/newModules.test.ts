import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERTS, defaultSettings, type AppLanguage } from '@vade/protocol';
import { buildDiagnosticsEntries, REDACTED, redactAdminSettings } from '../src/main/diagnostics';
import { pickAdminLanIp } from '../src/main/agentPackage';
import { AdminStore } from '../src/main/store';
import { createZipBuffer, writeZipFile } from '../src/main/zip';
import { DICTIONARIES } from '../src/renderer/i18n';
import { uk } from '../src/renderer/i18n/uk';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-admin-mod-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runPs(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`, 'utf16le').toString('base64');
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

describe('Stages 4 & 6: Pure-Node ZIP archive builder & Windows ZipFile extraction', () => {
  it('writes valid STORE and DEFLATE entries including UTF-8 filenames and extracts cleanly with .NET ZipFile', async () => {
    const zipPath = path.join(tmp, 'test-archive.zip');
    const outDir = path.join(tmp, 'extracted');
    await writeZipFile(zipPath, [
      { name: 'preconfig.json', data: JSON.stringify({ clubKey: 'abc', port: 7420 }) },
      { name: 'nested/інструкція-uk.txt', data: 'Привіт, Vade Launcher! '.repeat(20) },
      { name: 'bin/stored.bin', data: Buffer.from([0x4d, 0x5a, 0x90, 0x00]), store: true },
    ]);

    const raw = createZipBuffer([{ name: 'a.txt', data: 'hello' }]);
    expect(raw.readUInt32LE(0)).toBe(0x04034b50);

    await runPs(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${outDir.replace(/'/g, "''")}')`);
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'preconfig.json'), 'utf8'))).toEqual({ clubKey: 'abc', port: 7420 });
    expect(fs.readFileSync(path.join(outDir, 'nested', 'інструкція-uk.txt'), 'utf8')).toBe('Привіт, Vade Launcher! '.repeat(20));
    expect(fs.readFileSync(path.join(outDir, 'bin', 'stored.bin')).equals(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(true);
  }, 25_000);

  it('picks matching LAN IP for preconfig.json from subnet', () => {
    expect(pickAdminLanIp('10.70.4.0/24', ['192.168.1.50', '10.70.4.10'])).toBe('10.70.4.10');
    expect(pickAdminLanIp('10.70.4.0/24', ['192.168.1.50'])).toBe('192.168.1.50');
  });
});

describe('Stage 6: Diagnostics secret redaction', () => {
  it('never leaks clubKey, site.token, or pinHash into diagnostics ZIP entries', () => {
    const s = defaultSettings('secret-club-key-abcdef123456');
    s.site.token = 'cf-secret-bearer-token-9999';
    s.security.pinHash = 'salt1234:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const redacted = redactAdminSettings(s);
    expect(redacted.security.clubKey).toBe(REDACTED);
    expect(redacted.security.pinHash).toBe(REDACTED);
    expect(redacted.site.token).toBe(REDACTED);

    const entries = buildDiagnosticsEntries({
      appVersion: '0.4.0',
      settings: s,
      pcs: [{ id: 1, ip: '10.70.4.101', mac: '30:56:0f:3e:93:88', zone: 'Regular' }],
      history: [],
      runtimes: [],
      localIps: ['10.70.4.10'],
      getLogs: () => [{ ts: '2026-01-01T00:00:00Z', level: 'info', msg: `Token leak ${s.site.token} key=${s.security.clubKey}` }],
      pcId: 1,
      agentBundle: null,
      agentBundleError: 'Offline',
    });

    const allText = entries.map((e) => (Buffer.isBuffer(e.data) ? e.data.toString('utf8') : e.data)).join('\n');
    expect(allText).not.toContain('secret-club-key-abcdef123456');
    expect(allText).not.toContain('cf-secret-bearer-token-9999');
    expect(allText).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(allText).toContain(REDACTED);
  });
});

describe('Stage 3: AdminStore PIN protection & settings preservation', () => {
  it('sets, verifies, changes, disables PIN and preserves pinHash when regenerating key or saving settings', () => {
    const store = new AdminStore(path.join(tmp, 'data'));
    expect(store.verifyPin('')).toBe(true);

    expect(store.setPin(undefined, '1234').ok).toBe(true);
    expect(store.settings.security.pinHash).toBeTruthy();
    expect(store.verifyPin('1234')).toBe(true);
    expect(store.verifyPin('0000')).toBe(false);

    // Wrong current PIN blocks change
    expect(store.setPin('0000', '5678').ok).toBe(false);
    expect(store.setPin('1234', '5678').ok).toBe(true);
    expect(store.verifyPin('5678')).toBe(true);

    // Regenerating key & saving settings do NOT erase pinHash
    const hashBefore = store.settings.security.pinHash;
    store.regenerateKey();
    expect(store.settings.security.pinHash).toBe(hashBefore);

    const next = structuredClone(store.settings);
    next.clubAppIds = [730, 570, 1422450];
    next.ui.language = 'pl';
    store.saveSettings(next);
    expect(store.settings.security.pinHash).toBe(hashBefore);
    expect(store.settings.clubAppIds).toEqual([730, 570, 1422450]);
    expect(store.settings.ui.language).toBe('pl');

    // Disable PIN
    expect(store.setPin('5678', null).ok).toBe(true);
    expect(store.settings.security.pinHash).toBe('');
  });
});

describe('Stage 7: i18n dictionary completeness & placeholders parity', () => {
  const placeholdersOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('has identical key sets and interpolation placeholders across uk, pl, en', () => {
    const baseKeys = Object.keys(uk).sort();
    for (const lang of ['uk', 'pl', 'en'] as AppLanguage[]) {
      const dict = DICTIONARIES[lang];
      expect(Object.keys(dict).sort()).toEqual(baseKeys);
      for (const k of baseKeys) {
        const val = dict[k as keyof typeof uk];
        expect(val.trim().length, `${lang}.${k} empty`).toBeGreaterThan(0);
        expect(placeholdersOf(val), `${lang}.${k} placeholder mismatch`).toEqual(placeholdersOf(uk[k as keyof typeof uk]));
      }
    }
  });

  it('has zero unused dictionary keys and zero raw Cyrillic in new UI components', () => {
    const rendererRoot = path.resolve(__dirname, '../src/renderer');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const nonI18nSources = walk(rendererRoot)
      .filter((p) => !p.includes(`${path.sep}i18n${path.sep}`))
      .map((p) => fs.readFileSync(p, 'utf8'))
      .join('\n');

    for (const key of Object.keys(uk)) {
      if (key.startsWith('status.') || key.startsWith('queue.') || key.startsWith('occ.')) continue;
      expect(nonI18nSources, `Unused i18n key: ${key}`).toContain(key);
    }

    for (const file of ['GamesView.tsx', 'DiagDialog.tsx', 'DeployDialog.tsx', 'PinPromptModal.tsx', 'SaveBar.tsx', 'ui.tsx']) {
      const noComments = fs
        .readFileSync(path.join(rendererRoot, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(noComments, `Raw Cyrillic left in ${file}`).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
    }
  });
});

describe('Stage 8: Legacy config migration & persistence', () => {
  it('hydrates defaults cleanly from a minimal legacy settings.json and pcs.json without crashing', () => {
    const dir = path.join(tmp, 'legacy-data');
    fs.mkdirSync(dir, { recursive: true });
    // Minimal v0.1 settings lacking modern fields (clubAppIds, pinHash, ui.language, extraUpdaters, zoneThresholds, ignoreAppIds, etc.)
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        security: { clubKey: 'legacy-club-key-0123456789' },
        network: { subnet: '192.168.10.0/24', broadcast: '192.168.10.255', agentPort: 7420, wolPort: 9 },
        ui: { autostart: false, closeToTray: false, theme: 'invalid-legacy-theme' },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'pcs.json'),
      JSON.stringify([
        { id: 10, ip: '192.168.10.10', mac: '30-56-0F-3E-93-88' },
        { id: 2, ip: '192.168.10.2', mac: '3056.0f3e.910a', zone: 'VIP' },
      ]),
    );

    const store = new AdminStore(dir);
    expect(store.settings.security.clubKey).toBe('legacy-club-key-0123456789');
    expect(store.settings.security.pinHash).toBe('');
    expect(store.settings.clubAppIds).toEqual([730, 570, 578080]);
    expect(store.settings.maintenance.update.ignoreAppIds).toEqual([]);
    expect(store.settings.maintenance.update.treatNoSubscriptionAsError).toBe(false);
    expect(store.settings.alerts.minRamGb).toBe(DEFAULT_ALERTS.minRamGb);
    expect(store.settings.ui.theme).toBe('system');
    expect(store.settings.ui.language).toBe('uk');
    expect(store.settings.ui.historyRetentionDays).toBe(14);

    // PCs sorted by id, missing zone filled, MACs normalized
    expect(store.pcs.map((p) => p.id)).toEqual([2, 10]);
    expect(store.pcs[0].mac).toBe('30:56:0f:3e:91:0a');
    expect(store.pcs[0].zone).toBe('VIP');
    expect(store.pcs[1].mac).toBe('30:56:0f:3e:93:88');
    expect(store.pcs[1].zone).toBe('Regular');
  });

  it('preserves optional alerts.zoneThresholds across AdminStore restarts', () => {
    const dir = path.join(tmp, 'zones-data');
    const store1 = new AdminStore(dir);
    const next = structuredClone(store1.settings);
    next.alerts.zoneThresholds = { VIP: { minRamGb: 64, minRefreshRateHz: 360 } };
    next.clubAppIds = [730, 1422450];
    next.ui.language = 'en';
    store1.saveSettings(next);

    const store2 = new AdminStore(dir);
    expect(store2.settings.alerts.zoneThresholds).toEqual({ VIP: { minRamGb: 64, minRefreshRateHz: 360 } });
    expect(store2.settings.clubAppIds).toEqual([730, 1422450]);
    expect(store2.settings.ui.language).toBe('en');
  });
});

describe('Stage 4: install.ps1 PowerShell syntax check', () => {
  it('parses apps/agent/install/install.ps1 with zero syntax errors', async () => {
    const ps1 = path.resolve(__dirname, '../../agent/install/install.ps1');
    const errCount = await runPs(
      `$errs = $null; $t = $null; [System.Management.Automation.Language.Parser]::ParseFile('${ps1.replace(/'/g, "''")}', [ref]$t, [ref]$errs) | Out-Null; $errs.Count`,
    );
    expect(Number(errCount)).toBe(0);
  });
});
