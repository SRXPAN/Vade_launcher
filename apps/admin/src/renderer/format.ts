import { isPcScheduled, OCCUPANCY_REASON_TITLES, pcRunTime } from '@vade/protocol';
import type { AppSettings, AppUpdateStatus, DisplayStatus, JobResult, Occupancy, PcRecord, PcRuntime, StepStatus } from '@vade/protocol';
import type { PcAction, QueueItemStateUi } from '../shared/api';

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  sleeping: 'Sleeping',
  cleaning: 'Cleaning',
  updating: 'Updating',
  error: 'Error',
};

export const STATUS_ORDER: DisplayStatus[] = ['online', 'updating', 'cleaning', 'sleeping', 'offline', 'error'];

export interface ActionMeta {
  label: string;
  /** Shown in a confirmation dialog before the action runs */
  confirm?: string;
  danger?: boolean;
}

export const ACTIONS: Record<PcAction, ActionMeta> = {
  wake: { label: 'Увімкнути (WoL)' },
  test: {
    label: 'Обслуговування зараз',
    confirm:
      'Буде закрито Steam, очищено TEMP / логіни / кеш і запущено оновлення ігор. ПК після цього НЕ вимикається (тестовий запуск). Якщо за ПК грають — гравця викине зі Steam.',
  },
  run: {
    label: 'Обслуговування + вимкнення',
    confirm: 'Повне обслуговування з дією після завершення (сон / гібернація / вимкнення згідно з налаштуваннями).',
  },
  cancel: { label: 'Скасувати завдання' },
  sleep: { label: 'Сон', confirm: 'Перевести вибрані ПК у сон?' },
  hibernate: { label: 'Гібернація', confirm: 'Перевести вибрані ПК у гібернацію?' },
  shutdown: { label: 'Вимкнути', confirm: 'Вимкнути вибрані ПК? Незбережені дані гравців буде втрачено.', danger: true },
  restart: { label: 'Перезавантажити', confirm: 'Перезавантажити вибрані ПК?', danger: true },
  'cancel-power': { label: 'Скасувати вимкнення' },
  'clean-logins': {
    label: 'Очистити логіни зараз',
    confirm:
      'Буде закрито Steam, Discord і браузери, видалено вхід у Steam і сесії браузерів (куки, збережені паролі, вкладки). Кеш, ігри й Майстерня не чіпаються.',
  },
  'sync-time': { label: 'Синхронізувати час' },
};

export const QUEUE_STATE_LABEL: Record<QueueItemStateUi, string> = {
  queued: 'у черзі',
  running: 'виконується',
  done: 'готово',
  failed: 'помилка',
  skipped: 'пропущено',
  cancelled: 'скасовано',
};

export const STEP_ICON_CLASS: Record<StepStatus, string> = {
  pending: 's-pending',
  running: 's-running',
  ok: 's-ok',
  skipped: 's-skipped',
  error: 's-error',
};

export const APP_STATUS: Record<AppUpdateStatus, { label: string; cls: string }> = {
  pending: { label: 'в черзі', cls: 's-pending' },
  updating: { label: 'оновлюється', cls: 's-running' },
  ok: { label: 'OK', cls: 's-ok' },
  ignored: { label: 'Ігноровано', cls: 's-skipped' },
  skipped_no_subscription: { label: 'Skipped - No subscription', cls: 's-skipped' },
  error: { label: 'ERROR', cls: 's-error' },
  login_error: { label: 'LOGIN ERROR', cls: 's-error' },
};

export const RESULT_LABEL: Record<JobResult, string> = {
  ok: 'OK',
  errors: 'з помилками',
  cancelled: 'скасовано',
};

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(iso: string | null | undefined, locale = 'uk-UA', todayPrefix?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return todayPrefix ? todayPrefix.replace('{time}', time) : `сьогодні ${time}`;
  return `${d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })} ${time}`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'ніколи';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'щойно';
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
  return fmtDateTime(iso);
}

export function fmtBytes(n: number): string {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Occupancy reported by a connected agent; null when the PC is not online. */
export function occupancyOf(rt: PcRuntime | undefined): Occupancy | null {
  if (!rt || rt.link !== 'online' || !rt.status) return null;
  return rt.status.occupancy ?? 'unknown';
}

export function occupancyText(rt: PcRuntime | undefined): string {
  const s = rt?.status;
  if (!s?.occupancyReason) return 'агент не повідомляє про зайнятість (версія до 0.2)';
  return `${OCCUPANCY_REASON_TITLES[s.occupancyReason]}${s.occupancyDetail ? ` — ${s.occupancyDetail}` : ''}`;
}

/** "03:17" (own slot), "черга з 03:00" (queue mode) or null when the PC is not in the night schedule. */
export function scheduleLabel(settings: AppSettings, pc: PcRecord): string | null {
  if (!isPcScheduled(settings, pc)) return null;
  return settings.schedule.mode === 'queue' ? `черга з ${settings.schedule.startTime}` : pcRunTime(settings.schedule, pc.id);
}

export function nextFreeId(pcs: PcRecord[]): number {
  const used = new Set(pcs.map((p) => p.id));
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

export function zonesOf(pcs: PcRecord[]): string[] {
  const set = new Set<string>(['Regular', 'Stream']);
  for (const p of pcs) set.add(p.zone);
  return [...set];
}
