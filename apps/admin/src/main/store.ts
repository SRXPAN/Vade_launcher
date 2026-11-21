import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSER_IDS,
  defaultSettings,
  isValidIPv4,
  normalizeMac,
  parseCidr,
  parseHHMM,
  SEED_PCS,
  validatePc,
  type AppSettings,
  type PcRecord,
} from '@vade/protocol';
import { newClubKey } from '@vade/protocol/auth';

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

/** Atomic write with a .bak of the previous version. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

/** Fills fields missing in an older settings.json with defaults (forward compatible). */
function mergeDefaults<T>(defaults: T, loaded: unknown): T {
  if (loaded === undefined || loaded === null) return defaults;
  if (Array.isArray(defaults)) return (Array.isArray(loaded) ? loaded : defaults) as T;
  if (typeof defaults !== 'object' || defaults === null) return (typeof loaded === typeof defaults ? loaded : defaults) as T;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const k of Object.keys(out)) out[k] = mergeDefaults(out[k], (loaded as Record<string, unknown>)[k]);
  return out as T;
}

const clamp = (v: number, min: number, max: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

const cleanIds = (ids: unknown): number[] =>
  Array.isArray(ids) ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];

/** Settings are normalised before saving so a bad value can never reach the agents. */
export function sanitizeSettings(input: AppSettings, current: AppSettings): AppSettings {
  const s = mergeDefaults(current, input);
  const errors: string[] = [];
  if (parseHHMM(s.schedule.startTime) == null) errors.push('Некоректний час старту (HH:MM).');
  if (!parseCidr(s.network.subnet)) errors.push('Некоректна підмережа (наприклад 10.70.4.0/24).');
  if (!isValidIPv4(s.network.broadcast)) errors.push('Некоректна broadcast-адреса.');
  if (!/^[A-Za-z]:\\.+/.test(s.maintenance.steamPath)) errors.push('Шлях до Steam має бути повним, наприклад C:\\Program Files (x86)\\Steam.');
  if (!/^[A-Za-z]:\\.+/.test(s.maintenance.steamcmdDir)) errors.push('Шлях до SteamCMD має бути повним, наприклад C:\\steamcmd.');
  if (s.security.clubKey.trim().length < 16) errors.push('Ключ клубу закороткий (мінімум 16 символів).');
  s.site.url = s.site.url.trim();
  if (s.site.enabled && !s.site.url) errors.push('Вкажіть Webhook URL або вимкніть синхронізацію з сайтом.');
  if (s.site.url) {
    let ok = false;
    try {
      ok = ['https:', 'http:'].includes(new URL(s.site.url).protocol);
    } catch {
      ok = false;
    }
    if (!ok) errors.push('Webhook URL має бути повною адресою: https://…');
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const cleanNames = (list: unknown): string[] => {
    const out: string[] = [];
    for (const v of Array.isArray(list) ? list : []) {
      const t = String(v).trim();
      if (t && t.length <= 200 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out.slice(0, 300);
  };
  s.detector.idleMinutes = clamp(s.detector.idleMinutes, 1, 240, 10);
  s.detector.gameProcesses = cleanNames(s.detector.gameProcesses);
  s.detector.senetProcesses = cleanNames(s.detector.senetProcesses);
  s.detector.senetLockTitles = cleanNames(s.detector.senetLockTitles);
  s.schedule.mode = s.schedule.mode === 'queue' ? 'queue' : 'staggered';
  s.schedule.maxConcurrentUpdates = clamp(s.schedule.maxConcurrentUpdates, 1, 10, 3);
  s.schedule.zoneOrder = cleanNames(s.schedule.zoneOrder);
  const p = s.postSessionClean;
  p.delaySec = clamp(p.delaySec, 0, 600, 45);
  p.closeApps = cleanNames(p.closeApps);
  p.browsers = BROWSER_IDS.filter((b) => p.browsers.includes(b));
  s.alerts.diskWarnGb = clamp(s.alerts.diskWarnGb, 1, 100_000, 30);
  s.alerts.diskCritGb = Math.min(clamp(s.alerts.diskCritGb, 1, 100_000, 15), s.alerts.diskWarnGb);
  s.site.token = s.site.token.trim();
  s.site.heartbeatSec = clamp(s.site.heartbeatSec, 15, 86_400, 600);
  s.site.debounceSec = clamp(s.site.debounceSec, 0, 60, 2);
  s.site.dailyLimit = clamp(s.site.dailyLimit, 0, 1_000_000, 900);

  s.schedule.stepMin = clamp(s.schedule.stepMin, 0, 60, 1);
  s.schedule.wolLeadMin = clamp(s.schedule.wolLeadMin, 1, 15, 2);
  s.schedule.catchUpMin = clamp(s.schedule.catchUpMin, 0, 240, 30);
  s.network.agentPort = clamp(s.network.agentPort, 1, 65535, 7420);
  s.network.wolPort = clamp(s.network.wolPort, 1, 65535, 9);
  s.maintenance.after.delaySec = clamp(s.maintenance.after.delaySec, 30, 60, 30);
  s.maintenance.update.appIds = cleanIds(s.maintenance.update.appIds);
  s.maintenance.workshop.appIds = cleanIds(s.maintenance.workshop.appIds);
  s.maintenance.update.steamUser = s.maintenance.update.steamUser.trim();
  s.maintenance.steamPath = s.maintenance.steamPath.trim().replace(/\\+$/, '');
  s.maintenance.steamcmdDir = s.maintenance.steamcmdDir.trim().replace(/\\+$/, '');
  s.security.clubKey = s.security.clubKey.trim();
  return s;
}

/** settings.json + pcs.json in %APPDATA%\Vade Launcher\data */
export class AdminStore {
  settings: AppSettings;
  pcs: PcRecord[];
  readonly settingsFile: string;
  readonly pcsFile: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = path.join(dir, 'settings.json');
    this.pcsFile = path.join(dir, 'pcs.json');

    const loaded = readJson<AppSettings>(this.settingsFile);
    this.settings = mergeDefaults(defaultSettings(newClubKey()), loaded);
    if (!this.settings.security.clubKey) this.settings.security.clubKey = newClubKey();
    if (!loaded) writeJson(this.settingsFile, this.settings);

    const pcs = readJson<PcRecord[]>(this.pcsFile);
    this.pcs = Array.isArray(pcs) ? pcs : structuredClone(SEED_PCS);
    if (!pcs) writeJson(this.pcsFile, this.pcs);
    this.sortPcs();
  }

  saveSettings(next: AppSettings): AppSettings {
    this.settings = sanitizeSettings(next, this.settings);
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  regenerateKey(): AppSettings {
    this.settings = { ...this.settings, security: { clubKey: newClubKey() } };
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  savePc(input: PcRecord, originalId: number | null): { ok: true } | { ok: false; errors: string[] } {
    const pc: PcRecord = {
      id: Number(input.id),
      ip: String(input.ip ?? '').trim(),
      mac: String(input.mac ?? '').trim(),
      zone: String(input.zone ?? '').trim() || 'Regular',
    };
    if (input.name?.trim()) pc.name = input.name.trim();
    const o = input.overrides ?? {};
    const overrides: PcRecord['overrides'] = {};
    if (o.scheduleEnabled === false) overrides.scheduleEnabled = false;
    if (o.afterAction) overrides.afterAction = o.afterAction;
    const ids = cleanIds(o.updateAppIds);
    if (ids.length) overrides.updateAppIds = ids;
    if (Object.keys(overrides).length) pc.overrides = overrides;

    const errors = validatePc(pc, this.pcs, originalId);
    if (errors.length) return { ok: false, errors };
    pc.mac = normalizeMac(pc.mac)!;
    const idx = originalId == null ? -1 : this.pcs.findIndex((p) => p.id === originalId);
    if (idx >= 0) this.pcs[idx] = pc;
    else this.pcs.push(pc);
    this.sortPcs();
    writeJson(this.pcsFile, this.pcs);
    return { ok: true };
  }

  deletePcs(ids: number[]): void {
    this.pcs = this.pcs.filter((p) => !ids.includes(p.id));
    writeJson(this.pcsFile, this.pcs);
  }

  /** Used when an agent reports its MAC and the record has none / an obviously wrong one. */
  setMac(id: number, mac: string): void {
    const pc = this.pcs.find((p) => p.id === id);
    if (!pc) return;
    pc.mac = mac;
    writeJson(this.pcsFile, this.pcs);
  }

  private sortPcs(): void {
    this.pcs.sort((a, b) => a.id - b.id);
  }
}
