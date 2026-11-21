import { formatHHMM, pcRunMinute } from './schedule';
import type {
  AgentConfigPayload,
  AgentStatus,
  AlertSettings,
  AppSettings,
  DiskInfo,
  DisplayStatus,
  MaintenanceConfig,
  PcRecord,
  PcRuntime,
  PublicPcStatus,
  SitePayload,
} from './types';

/** Global maintenance settings with the PC's individual overrides applied. */
export function resolveMaintenance(settings: AppSettings, pc: PcRecord): MaintenanceConfig {
  const m = structuredClone(settings.maintenance);
  const o = pc.overrides;
  if (o?.afterAction) m.after.action = o.afterAction;
  if (o?.updateAppIds && o.updateAppIds.length > 0) {
    m.update.mode = 'list';
    m.update.appIds = [...o.updateAppIds];
  }
  return m;
}

export function isPcScheduled(settings: AppSettings, pc: PcRecord): boolean {
  return settings.schedule.enabled && pc.overrides?.scheduleEnabled !== false;
}

/** What the admin app pushes to the agent of `pc` with `config.apply`. */
export function buildAgentConfig(settings: AppSettings, pc: PcRecord): AgentConfigPayload {
  const runMinute = pcRunMinute(settings.schedule, pc.id);
  const body = {
    pcId: pc.id,
    maintenance: resolveMaintenance(settings, pc),
    schedule: {
      // In queue mode the admin PC starts the jobs; the agent's own timer would run them a second time.
      enabled: isPcScheduled(settings, pc) && runMinute != null && settings.schedule.mode !== 'queue',
      runTime: formatHHMM(runMinute ?? 0),
      wakeLeadMin: settings.schedule.wolLeadMin,
      catchUpMin: settings.schedule.catchUpMin,
    },
    detector: structuredClone(settings.detector),
    postSessionClean: structuredClone(settings.postSessionClean),
  };
  return { rev: hashString(stableStringify(body)), ...body };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32 bit, hex. Enough to detect config drift; not a security primitive. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function agentBusy(status: AgentStatus | null): boolean {
  return !!status && (status.state === 'cleaning' || status.state === 'updating' || status.state === 'steam-login');
}

export function deriveDisplayStatus(rt: PcRuntime | undefined): DisplayStatus {
  if (!rt) return 'offline';
  if (rt.link === 'online' && rt.status) {
    const s = rt.status;
    if (s.state === 'cleaning') return 'cleaning';
    if (s.state === 'updating' || s.state === 'steam-login') return 'updating';
    if (s.lastJob?.result === 'errors') return 'error';
    return 'online';
  }
  if (rt.link === 'auth-failed' || rt.link === 'incompatible') return 'error';
  return rt.sleeping ? 'sleeping' : 'offline';
}

/**
 * Status for the public booking map.
 *  - offline:     the agent is not connected (PC off, asleep, or not reachable)
 *  - maintenance: a job / SteamCMD login / power action is running
 *  - occupied:    a player is there — and also when the agent cannot tell ("unknown"),
 *                 so the site never offers a seat that may be taken
 *  - free:        the detector says nobody is there
 */
export function publicPcStatus(rt: PcRuntime | undefined): PublicPcStatus {
  if (!rt || rt.link !== 'online' || !rt.status) return 'offline';
  const s = rt.status;
  if (s.job || s.state !== 'idle') return 'maintenance';
  return s.occupancy === 'free' ? 'free' : 'occupied';
}

/** Payload for the club website. Deliberately contains only id, zone and public status. */
export function buildSitePayload(pcs: PcRecord[], runtimes: (id: number) => PcRuntime | undefined, now = new Date()): SitePayload {
  return {
    updatedAt: now.toISOString(),
    pcs: [...pcs].sort((a, b) => a.id - b.id).map((pc) => ({ id: pc.id, zone: pc.zone, status: publicPcStatus(runtimes(pc.id)) })),
  };
}

/** Identity of a payload without the timestamp: equal signatures = nothing changed for the site. */
export function sitePayloadSignature(p: SitePayload): string {
  return p.pcs.map((x) => `${x.id}:${x.zone}:${x.status}`).join('|');
}

/** "cs2.exe, dota2.exe\nTslGame.exe" -> ["cs2.exe", "dota2.exe", "TslGame.exe"] (deduplicated, case-insensitive). */
export function parseNameList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\r\n,;]+/)) {
    const v = raw.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Disks                                                               */
/* ------------------------------------------------------------------ */

export type DiskLevel = 'ok' | 'warn' | 'crit';
const GB = 1024 ** 3;

/** Free space below diskCritGb = crit (red), below diskWarnGb = warn (yellow). */
export function diskLevel(freeBytes: number, alerts: AlertSettings): DiskLevel {
  const gb = freeBytes / GB;
  if (gb < alerts.diskCritGb) return 'crit';
  if (gb < alerts.diskWarnGb) return 'warn';
  return 'ok';
}

export function worstDiskLevel(disks: DiskInfo[] | undefined, alerts: AlertSettings): DiskLevel {
  let worst: DiskLevel = 'ok';
  for (const d of disks ?? []) {
    const l = diskLevel(d.freeBytes, alerts);
    if (l === 'crit') return 'crit';
    if (l === 'warn') worst = 'warn';
  }
  return worst;
}

/** 45.2 GB -> "45 GB", 7.4 GB -> "7.4 GB" */
export function formatGb(bytes: number): string {
  const gb = bytes / GB;
  return `${gb < 10 ? gb.toFixed(1) : Math.floor(gb)} GB`;
}

/* ------------------------------------------------------------------ */
/* Versions and queue order                                            */
/* ------------------------------------------------------------------ */

/** "0.10.1" vs "0.9" -> 1; non-numeric parts are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Queue order: zones in zoneOrder first (in that order), then the remaining zones; by PC number inside a zone. */
export function orderQueue<T extends Pick<PcRecord, 'id' | 'zone'>>(pcs: T[], zoneOrder: string[]): T[] {
  const rank = (zone: string) => {
    const i = zoneOrder.findIndex((z) => z.toLowerCase() === zone.toLowerCase());
    return i < 0 ? zoneOrder.length : i;
  };
  return [...pcs].sort((a, b) => rank(a.zone) - rank(b.zone) || a.id - b.id);
}

export const DISPLAY_STATUS_TITLES: Record<DisplayStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  sleeping: 'Sleeping',
  cleaning: 'Cleaning',
  updating: 'Updating',
  error: 'Error',
};
