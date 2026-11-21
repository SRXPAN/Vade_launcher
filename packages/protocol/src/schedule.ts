import type { ScheduleSettings } from './types';

const DAY = 1440;

/** "11:00" -> 660. Returns null for invalid input. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 660 -> "11:00"; wraps around midnight. */
export function formatHHMM(minuteOfDay: number): string {
  const v = ((Math.round(minuteOfDay) % DAY) + DAY) % DAY;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * Minute of day when the PC starts its night job:
 * startTime + (pcId - 1) * stepMin — the same formula as the old .bat.
 */
export function pcRunMinute(s: Pick<ScheduleSettings, 'startTime' | 'stepMin'>, pcId: number): number | null {
  const base = parseHHMM(s.startTime);
  if (base == null) return null;
  return (((base + (pcId - 1) * s.stepMin) % DAY) + DAY) % DAY;
}

export function pcRunTime(s: Pick<ScheduleSettings, 'startTime' | 'stepMin'>, pcId: number): string | null {
  const m = pcRunMinute(s, pcId);
  return m == null ? null : formatHHMM(m);
}

function atMinuteOfDay(day: Date, minuteOfDay: number): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minuteOfDay);
  return d;
}

/** Most recent occurrence of minuteOfDay at or before `now`. */
export function lastOccurrence(minuteOfDay: number, now: Date): Date {
  const d = atMinuteOfDay(now, minuteOfDay);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return atMinuteOfDay(d, minuteOfDay);
}

/** Next occurrence of minuteOfDay strictly after `now`. */
export function nextOccurrence(minuteOfDay: number, now: Date): Date {
  const d = atMinuteOfDay(now, minuteOfDay);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return atMinuteOfDay(d, minuteOfDay);
}

/** Local calendar date of an occurrence, used to run a job at most once per slot. */
export function occurrenceKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60000;
}
