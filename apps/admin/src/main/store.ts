import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSER_IDS,
  DEFAULT_CLEAN_LAUNCHERS,
  defaultSettings,
  isValidIPv4,
  LAUNCHER_IDS,
  normalizeMac,
  parseCidr,
  parseHHMM,
  SEED_PCS,
  validatePc,
  type AppSettings,
  type ExtraUpdaterApp,
  type HealthThresholds,
  type JobHistoryEntry,
  type JobState,
  type PcRecord,
} from '@vade/protocol';
import { hashPin, newClubKey, verifyPin } from '@vade/protocol/auth';
import { defaultMapLayout, sanitizeMapLayout, type MapLayout } from '../shared/mapLayout';
import { HistoryStore } from './history';

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
  s.schedule.autoSyncTime = s.schedule.autoSyncTime !== false;
  const p = s.postSessionClean;
  p.delaySec = clamp(p.delaySec, 0, 600, 45);
  p.closeApps = cleanNames(p.closeApps);
  p.browsers = BROWSER_IDS.filter((b) => p.browsers.includes(b));
  const rawLaunchers = (p.cleanLaunchers ?? {}) as Record<string, unknown>;
  p.cleanLaunchers = {
    riot: typeof rawLaunchers.riot === 'boolean' ? rawLaunchers.riot : DEFAULT_CLEAN_LAUNCHERS.riot,
    epic: typeof rawLaunchers.epic === 'boolean' ? rawLaunchers.epic : DEFAULT_CLEAN_LAUNCHERS.epic,
    battlenet: typeof rawLaunchers.battlenet === 'boolean' ? rawLaunchers.battlenet : DEFAULT_CLEAN_LAUNCHERS.battlenet,
    ea: typeof rawLaunchers.ea === 'boolean' ? rawLaunchers.ea : DEFAULT_CLEAN_LAUNCHERS.ea,
    discord: typeof rawLaunchers.discord === 'boolean' ? rawLaunchers.discord : DEFAULT_CLEAN_LAUNCHERS.discord,
    telegram: typeof rawLaunchers.telegram === 'boolean' ? rawLaunchers.telegram : DEFAULT_CLEAN_LAUNCHERS.telegram,
  };
  for (const id of LAUNCHER_IDS) {
    if (typeof p.cleanLaunchers[id] !== 'boolean') p.cleanLaunchers[id] = DEFAULT_CLEAN_LAUNCHERS[id];
  }
  s.alerts.diskWarnGb = clamp(s.alerts.diskWarnGb, 1, 100_000, 30);
  s.alerts.diskCritGb = Math.min(clamp(s.alerts.diskCritGb, 1, 100_000, 15), s.alerts.diskWarnGb);
  s.alerts.minRamGb = clamp(s.alerts.minRamGb, 0, 1024, 32);
  s.alerts.minRefreshRateHz = clamp(s.alerts.minRefreshRateHz, 0, 1000, 240);
  s.alerts.maxGpuTempC = clamp(s.alerts.maxGpuTempC, 0, 120, 85);
  s.alerts.maxSsdWearPct = clamp(s.alerts.maxSsdWearPct, 0, 100, 80);
  if (input.alerts?.zoneThresholds && typeof input.alerts.zoneThresholds === 'object') {
    const cleanZones: Record<string, Partial<HealthThresholds>> = {};
    for (const [z, raw] of Object.entries(input.alerts.zoneThresholds)) {
      const zoneName = z.trim();
      if (!zoneName || !raw || typeof raw !== 'object') continue;
      const entry: Partial<HealthThresholds> = {};
      if (typeof raw.minRamGb === 'number' && Number.isFinite(raw.minRamGb)) entry.minRamGb = clamp(raw.minRamGb, 0, 1024, 32);
      if (typeof raw.minRefreshRateHz === 'number' && Number.isFinite(raw.minRefreshRateHz)) {
        entry.minRefreshRateHz = clamp(raw.minRefreshRateHz, 0, 1000, 240);
      }
      if (typeof raw.maxGpuTempC === 'number' && Number.isFinite(raw.maxGpuTempC)) entry.maxGpuTempC = clamp(raw.maxGpuTempC, 0, 120, 85);
      if (typeof raw.maxSsdWearPct === 'number' && Number.isFinite(raw.maxSsdWearPct)) entry.maxSsdWearPct = clamp(raw.maxSsdWearPct, 0, 100, 80);
      if (Object.keys(entry).length) cleanZones[zoneName] = entry;
    }
    s.alerts.zoneThresholds = Object.keys(cleanZones).length ? cleanZones : undefined;
  } else {
    s.alerts.zoneThresholds = undefined;
  }
  s.site.token = s.site.token.trim();
  s.site.heartbeatSec = clamp(s.site.heartbeatSec, 15, 86_400, 600);
  s.site.debounceSec = clamp(s.site.debounceSec, 0, 60, 2);
  s.site.dailyLimit = clamp(s.site.dailyLimit, 0, 1_000_000, 900);

  s.schedule.stepMin = clamp(s.schedule.stepMin, 0, 60, 1);
  s.schedule.wolLeadMin = clamp(s.schedule.wolLeadMin, 1, 15, 2);
  s.schedule.catchUpMin = clamp(s.schedule.catchUpMin, 0, 240, 30);
  s.network.agentPort = clamp(s.network.agentPort, 1, 65535, 7420);
  s.network.wolPort = clamp(s.network.wolPort, 1, 65535, 9);
  s.network.discoveryEnabled = s.network.discoveryEnabled !== false;
  s.network.discoveryPort = clamp(s.network.discoveryPort, 1, 65535, 7422);
  s.maintenance.after.delaySec = clamp(s.maintenance.after.delaySec, 30, 60, 30);
  s.maintenance.update.appIds = cleanIds(s.maintenance.update.appIds);
  s.maintenance.update.ignoreAppIds = cleanIds(s.maintenance.update.ignoreAppIds);
  s.maintenance.update.treatNoSubscriptionAsError = s.maintenance.update.treatNoSubscriptionAsError === true;
  s.maintenance.workshop.appIds = cleanIds(s.maintenance.workshop.appIds);
  s.maintenance.update.steamUser = s.maintenance.update.steamUser.trim();
  s.maintenance.steamPath = s.maintenance.steamPath.trim().replace(/\\+$/, '');
  s.maintenance.steamcmdDir = s.maintenance.steamcmdDir.trim().replace(/\\+$/, '');
  const eu = s.maintenance.extraUpdaters;
  eu.enabled = eu.enabled === true;
  eu.minWaitMin = clamp(eu.minWaitMin, 0, 60, 3);
  eu.maxWaitMin = Math.max(eu.minWaitMin, clamp(eu.maxWaitMin, 1, 180, 20));
  eu.idleKbps = clamp(eu.idleKbps, 10, 100_000, 200);
  const rawApps = Array.isArray(input.maintenance?.extraUpdaters?.apps) ? input.maintenance.extraUpdaters.apps : eu.apps;
  const cleanApps: ExtraUpdaterApp[] = [];
  for (const a of Array.isArray(rawApps) ? rawApps : []) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name ?? '').trim().slice(0, 80);
    const exePath = String(a.exePath ?? '').trim().slice(0, 400);
    if (!name && !exePath) continue;
    const id = String(a.id ?? '').trim().slice(0, 40) || `app-${cleanApps.length + 1}`;
    const args = typeof a.args === 'string' ? a.args.trim().slice(0, 400) : '';
    cleanApps.push({ id, name: name || 'Client', exePath, ...(args ? { args } : {}), enabled: a.enabled !== false });
  }
  eu.apps = cleanApps.slice(0, 30);
  s.security.clubKey = s.security.clubKey.trim();
  // Preserve existing pinHash unless changed explicitly through setPin()
  s.security.pinHash = current.security.pinHash ?? '';
  s.clubAppIds = cleanIds(s.clubAppIds);
  s.ui.theme = s.ui.theme === 'light' || s.ui.theme === 'dark' || s.ui.theme === 'system' ? s.ui.theme : 'system';
  s.ui.language = s.ui.language === 'uk' || s.ui.language === 'pl' || s.ui.language === 'en' ? s.ui.language : 'uk';
  s.ui.historyRetentionDays = clamp(s.ui.historyRetentionDays, 1, 365, 14);
  return s;
}

/** Reads map_layout.json; a damaged file falls back to its .bak, then to the seed (without overwriting it). */
function loadMapLayout(file: string): { layout: MapLayout; fresh: boolean } {
  for (const f of [file, `${file}.bak`]) {
    const raw = readJson<unknown>(f);
    if (raw == null) continue;
    try {
      return { layout: sanitizeMapLayout(raw), fresh: false };
    } catch {
      // not a layout object: try the backup
    }
  }
  return { layout: defaultMapLayout(), fresh: !fs.existsSync(file) };
}

/** settings.json + pcs.json + map_layout.json + history.json in %APPDATA%\Vade Launcher\data */
export class AdminStore {
  settings: AppSettings;
  pcs: PcRecord[];
  mapLayout: MapLayout;
  readonly history: HistoryStore;
  readonly settingsFile: string;
  readonly pcsFile: string;
  readonly mapFile: string;
  readonly historyFile: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = path.join(dir, 'settings.json');
    this.pcsFile = path.join(dir, 'pcs.json');
    this.mapFile = path.join(dir, 'map_layout.json');
    this.historyFile = path.join(dir, 'history.json');

    const map = loadMapLayout(this.mapFile);
    this.mapLayout = map.layout;
    if (map.fresh) writeJson(this.mapFile, this.mapLayout);

    const loaded = readJson<AppSettings>(this.settingsFile);
    this.settings = mergeDefaults(defaultSettings(newClubKey()), loaded);
    if (!this.settings.security.clubKey) this.settings.security.clubKey = newClubKey();
    if (!loaded) writeJson(this.settingsFile, this.settings);

    const pcs = readJson<PcRecord[]>(this.pcsFile);
    this.pcs = Array.isArray(pcs) ? pcs : structuredClone(SEED_PCS);
    if (!pcs) writeJson(this.pcsFile, this.pcs);
    this.sortPcs();

    this.history = new HistoryStore(this.historyFile, this.settings.ui.historyRetentionDays);
  }

  saveSettings(next: AppSettings): AppSettings {
    this.settings = sanitizeSettings(next, this.settings);
    writeJson(this.settingsFile, this.settings);
    this.history.prune(this.settings.ui.historyRetentionDays);
    return this.settings;
  }

  listHistory(): JobHistoryEntry[] {
    return this.history.entries;
  }

  recordJobHistory(pcId: number, job: JobState): boolean {
    return this.history.record(pcId, job, this.settings.ui.historyRetentionDays);
  }

  saveMapLayout(next: unknown): MapLayout {
    this.mapLayout = sanitizeMapLayout(next);
    writeJson(this.mapFile, this.mapLayout);
    return this.mapLayout;
  }

  regenerateKey(): AppSettings {
    this.settings = { ...this.settings, security: { ...this.settings.security, clubKey: newClubKey() } };
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  verifyPin(pin: string): boolean {
    return verifyPin(pin, this.settings.security.pinHash);
  }

  setPin(currentPin: string | undefined, newPin: string | null): { ok: boolean; settings?: AppSettings; error?: string } {
    const hasExisting = !!(this.settings.security.pinHash ?? '').trim();
    if (hasExisting && !verifyPin(currentPin ?? '', this.settings.security.pinHash)) {
      return { ok: false, error: 'Невірний поточний PIN-код' };
    }
    if (newPin === null || newPin.trim() === '') {
      this.settings = { ...this.settings, security: { ...this.settings.security, pinHash: '' } };
      writeJson(this.settingsFile, this.settings);
      return { ok: true, settings: this.settings };
    }
    try {
      const nextHash = hashPin(newPin);
      this.settings = { ...this.settings, security: { ...this.settings.security, pinHash: nextHash } };
      writeJson(this.settingsFile, this.settings);
      return { ok: true, settings: this.settings };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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

  /** Updates a PC's IP in pcs.json when a UDP discovery beacon reports a new DHCP address for its MAC. */
  setIp(id: number, ip: string): boolean {
    const clean = ip.trim();
    if (!isValidIPv4(clean)) return false;
    const pc = this.pcs.find((p) => p.id === id);
    if (!pc || pc.ip === clean) return false;
    if (this.pcs.some((other) => other.id !== id && other.ip === clean)) return false;
    pc.ip = clean;
    writeJson(this.pcsFile, this.pcs);
    return true;
  }

  private sortPcs(): void {
    this.pcs.sort((a, b) => a.id - b.id);
  }
}
