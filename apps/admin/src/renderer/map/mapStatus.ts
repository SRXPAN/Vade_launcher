import {
  deriveDisplayStatus,
  isClockDrifted,
  worstDiskLevel,
  worstHealthLevel,
  type AlertSettings,
  type DiskLevel,
  type PcRuntime,
} from '@vade/protocol';
import { occupancyOf } from '../format';

/**
 * Colour of a PC on the club map.
 *  free / online: agent online, nobody at the PC (online = the detector cannot tell)
 *  busy:    a player is at the PC
 *  work:    cleaning / updating / SteamCMD login (animated)
 *  error:   last maintenance failed, wrong club key or incompatible agent
 *  sleep:   sent to sleep / hibernation by the admin app
 *  offline: agent not connected
 *  empty:   table number on the map that is not in pcs.json yet
 */
export type MapTone = 'free' | 'online' | 'busy' | 'work' | 'error' | 'sleep' | 'offline' | 'empty';

export const TONE_COLOR: Record<MapTone, string> = {
  free: 'var(--tone-free)',
  online: 'var(--tone-online)',
  busy: 'var(--tone-busy)',
  work: 'var(--tone-work)',
  error: 'var(--tone-error)',
  sleep: 'var(--tone-sleep)',
  offline: 'var(--tone-offline)',
  empty: 'var(--tone-empty)',
};

export const TONE_LABEL: Record<MapTone, string> = {
  free: 'Online · Вільний',
  online: 'Online · зайнятість невідома',
  busy: 'Online · Зайнятий',
  work: 'Обслуговування',
  error: 'Помилка',
  sleep: 'Сон',
  offline: 'Offline',
  empty: 'Не додано в базу',
};

/** Legend under the map, in the order a glance needs it. */
export const LEGEND: Array<{ tone: MapTone; label: string }> = [
  { tone: 'free', label: 'Вільний' },
  { tone: 'busy', label: 'Зайнятий' },
  { tone: 'work', label: 'Cleaning / Updating' },
  { tone: 'error', label: 'Помилка' },
  { tone: 'sleep', label: 'Сон' },
  { tone: 'offline', label: 'Offline' },
  { tone: 'empty', label: 'Не додано' },
];

export function mapTone(rt: PcRuntime | undefined, exists: boolean): MapTone {
  if (!exists) return 'empty';
  switch (deriveDisplayStatus(rt)) {
    case 'cleaning':
    case 'updating':
      return 'work';
    case 'error':
      return 'error';
    case 'sleeping':
      return 'sleep';
    case 'offline':
      return 'offline';
    default: {
      const occ = occupancyOf(rt);
      return occ === 'occupied' ? 'busy' : occ === 'free' ? 'free' : 'online';
    }
  }
}

/** Worst disk of an online PC, 'ok' when unknown. */
export function diskAlert(rt: PcRuntime | undefined, alerts: AlertSettings): DiskLevel {
  return rt?.link === 'online' ? worstDiskLevel(rt.status?.disks, alerts) : 'ok';
}

/** Combined alert indicator for the PC map icon (disks, hardware health, and clock drift). */
export function pcAlertLevel(rt: PcRuntime | undefined, alerts: AlertSettings, zone?: string): DiskLevel {
  if (rt?.link !== 'online') return 'ok';
  const disk = worstDiskLevel(rt.status?.disks, alerts);
  if (disk === 'crit') return 'crit';
  const hw = worstHealthLevel(rt.status?.health, alerts, zone);
  if (hw === 'crit') return 'crit';
  if (disk === 'warn' || hw === 'warn' || isClockDrifted(rt.status?.agentTimeMs)) return 'warn';
  return 'ok';
}

/** Download progress 0..1 of a running update, null when there is none. */
export function jobProgress(rt: PcRuntime | undefined): number | null {
  const p = rt?.link === 'online' ? rt.status?.job?.progress : null;
  return p ? Math.min(1, Math.max(0, p.pct / 100)) : null;
}
