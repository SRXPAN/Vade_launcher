/**
 * Auto-update manager for Vade Launcher (admin app) backed by GitHub Releases (`electron-updater`).
 */
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AppUpdateState } from '../shared/api';

export class AppUpdater extends EventEmitter<{ state: [AppUpdateState] }> {
  private current: AppUpdateState;
  private initialized = false;
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly appVersion: string) {
    super();
    this.current = { phase: 'idle', currentVersion: appVersion };
  }

  get state(): AppUpdateState {
    return this.current;
  }

  private update(patch: Partial<AppUpdateState>): void {
    this.current = { ...this.current, ...patch, currentVersion: this.appVersion };
    this.emit('state', this.current);
  }

  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      this.update({ phase: 'checking', message: undefined, percent: undefined });
    });
    autoUpdater.on('update-available', (info) => {
      this.update({ phase: 'available', availableVersion: info.version, message: `Знайдено версію ${info.version}` });
    });
    autoUpdater.on('update-not-available', () => {
      this.update({ phase: 'not-available', message: 'Встановлено найновішу версію' });
    });
    autoUpdater.on('download-progress', (p) => {
      this.update({ phase: 'downloading', percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.update({
        phase: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: `Готово до встановлення: v${info.version}`,
      });
    });
    autoUpdater.on('error', (err) => {
      this.update({ phase: 'error', message: err?.message || 'Помилка перевірки оновлень' });
    });
  }

  startAutoCheck(): void {
    if (!app.isPackaged) return;
    this.ensureInit();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates().catch(() => undefined);
    }, 5000);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async checkForUpdates(): Promise<AppUpdateState> {
    if (!app.isPackaged) {
      this.update({
        phase: 'not-available',
        message: 'Автооновлення доступне лише у зібраній версії застосунку',
      });
      return this.current;
    }
    this.ensureInit();
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.update({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return this.current;
  }

  quitAndInstall(beforeQuit: () => void): { ok: boolean; error?: string } {
    if (!app.isPackaged) {
      return { ok: false, error: 'Недоступно в режимі розробки' };
    }
    if (this.current.phase !== 'downloaded') {
      return { ok: false, error: 'Оновлення ще не завантажено' };
    }
    beforeQuit();
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
    return { ok: true };
  }
}
