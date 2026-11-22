import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain, Menu, nativeTheme, shell, Tray } from 'electron';
import type { AppSettings, PcRecord } from '@vade/protocol';
import { app, dialog } from 'electron';
import { IPC, type ActionOptions, type AgentUpdateRequest, type PcAction, type QueueStartRequest, type SteamLoginRequest } from '../shared/api';
import { sanitizeMapLayout } from '../shared/mapLayout';
import { agentPackageAvailable, agentPackageDir, exportAgentPackage } from './agentPackage';
import { AgentUpdater, fileSource, readBundledSource } from './agentUpdater';
import { AdminDiscoveryListener } from './discovery';
import { AgentHub } from './hub';
import { appIcon } from './icon';
import { MaintenanceQueue } from './maintenanceQueue';
import { localIpv4, scanNetwork } from './scanner';
import { WolScheduler } from './scheduler';
import { SitePublisher } from './sitePublisher';
import { AdminStore } from './store';

const DEV_URL = process.env.VADE_DEV_URL;
const ACTIONS: PcAction[] = ['wake', 'test', 'run', 'cancel', 'sleep', 'hibernate', 'shutdown', 'restart', 'cancel-power', 'clean-logins', 'sync-time'];

app.setName('Vade Launcher'); // userData = %APPDATA%\Vade Launcher
app.setAppUserModelId('ua.vade.launcher');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let trayHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--quit') || argv.includes('--updated')) {
      isQuitting = true;
      app.quit();
      return;
    }
    showWindow();
  });
  void app.whenReady().then(start);
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) return; // never register the dev electron.exe
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

function start(): void {
  Menu.setApplicationMenu(null);
  const store = new AdminStore(path.join(app.getPath('userData'), 'data'));
  nativeTheme.themeSource = store.settings.ui.theme;
  const hub = new AgentHub(store);
  const discovery = new AdminDiscoveryListener(store, hub);
  const queue = new MaintenanceQueue({
    pcs: () => store.pcs,
    runtime: (id) => hub.runtime(id),
    wake: (id, reason) => hub.wake(id, reason),
    startJob: (id, mode, force) => hub.startJob(id, mode, force),
    waitFor: (id, pred, ms, signal) => hub.waitFor(id, pred, ms, signal),
    log: (id, level, msg) => hub.adminLog(id, level, msg),
  });
  const updater = new AgentUpdater({
    runtime: (id) => hub.runtime(id),
    localAddressOf: (id) => hub.localAddressOf(id),
    selfUpdate: (id, args) => hub.selfUpdate(id, args),
    waitFor: (id, pred, ms, signal) => hub.waitFor(id, pred, ms, signal),
    log: (id, level, msg) => hub.adminLog(id, level, msg),
  });
  const pickedSources = new Map<string, Awaited<ReturnType<typeof fileSource>>>();
  const wol = new WolScheduler(store, hub, queue, path.join(store.dir, 'night-queue.json'));
  const site = new SitePublisher({
    getSettings: () => store.settings.site,
    getPcs: () => store.pcs,
    getRuntime: (id) => hub.runtime(id),
    stateFile: path.join(store.dir, 'site-counter.json'),
    userAgent: `VadeLauncher/${app.getVersion()}`,
  });
  const icon = appIcon(32);

  hub.on('runtimes', (r) => {
    win?.webContents.send(IPC.runtimesUpdate, r);
    site.notifyChange();
  });
  hub.on('logs', (b) => win?.webContents.send(IPC.logsAppend, b));
  hub.on('pcsChanged', (pcs) => win?.webContents.send(IPC.pcsChanged, pcs));
  hub.on('historyChanged', (h) => win?.webContents.send(IPC.historyUpdate, h));
  site.on('status', (s) => win?.webContents.send(IPC.siteUpdate, s));
  queue.on('status', (s) => win?.webContents.send(IPC.queueUpdate, s));
  updater.on('status', (s) => win?.webContents.send(IPC.agentUpdateUpdate, s));

  /* ---------------- IPC ---------------- */
  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    dataDir: store.dir,
    localIps: localIpv4().map((x) => x.ip),
    agentPackageAvailable: agentPackageAvailable(),
  }));
  ipcMain.handle(IPC.settingsGet, () => store.settings);
  ipcMain.handle(IPC.settingsSave, (_e, next: AppSettings) => {
    const prev = store.settings;
    const saved = store.saveSettings(next);
    if (prev.ui.autostart !== saved.ui.autostart) applyAutostart(saved.ui.autostart);
    if (prev.ui.theme !== saved.ui.theme) nativeTheme.themeSource = saved.ui.theme;
    hub.sync();
    hub.pushConfigAll();
    discovery.reconfigure();
    // Only site settings changes force a new request; other edits must not spend the daily budget.
    if (JSON.stringify(prev.site) !== JSON.stringify(saved.site)) site.reconfigure();
    return saved;
  });
  ipcMain.handle(IPC.settingsRegenKey, () => {
    const saved = store.regenerateKey();
    hub.sync();
    return saved;
  });
  ipcMain.handle(IPC.pcsList, () => store.pcs);
  ipcMain.handle(IPC.pcsSave, (_e, pc: PcRecord, originalId: number | null) => {
    const r = store.savePc(pc, originalId);
    if (!r.ok) return r;
    hub.sync();
    void hub.pushConfig(Number(pc.id)).catch(() => undefined);
    site.notifyChange();
    return { ok: true, pcs: store.pcs };
  });
  ipcMain.handle(IPC.pcsDelete, (_e, ids: number[]) => {
    store.deletePcs(ids.map(Number));
    hub.sync();
    site.notifyChange();
    return store.pcs;
  });
  ipcMain.handle(IPC.mapGet, () => store.mapLayout);
  ipcMain.handle(IPC.mapSave, (_e, layout: unknown) => store.saveMapLayout(layout));
  ipcMain.handle(IPC.mapExport, async (_e, layout: unknown) => {
    if (!win) return { ok: false };
    try {
      const clean = sanitizeMapLayout(layout);
      const r = await dialog.showSaveDialog(win, {
        title: 'Експортувати карту клубу',
        defaultPath: 'map_layout.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.writeFileSync(r.filePath, JSON.stringify(clean, null, 2), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.mapImport, async () => {
    if (!win) return { ok: false };
    try {
      const r = await dialog.showOpenDialog(win, {
        title: 'Імпортувати карту клубу',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8').replace(/^\uFEFF/, '')) as unknown;
      const layout = sanitizeMapLayout(raw);
      return { ok: true, layout };
    } catch (e) {
      return { ok: false, error: `Некоректний файл карти: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  ipcMain.handle(IPC.runtimesGet, () => hub.runtimes());
  ipcMain.handle(IPC.historyList, () => store.listHistory());
  ipcMain.handle(IPC.actionRun, (_e, action: PcAction, ids: number[], opts?: ActionOptions) => {
    if (!ACTIONS.includes(action)) throw new Error(`Невідома дія ${action}`);
    return hub.runAction(action, ids.map(Number), { force: opts?.force === true });
  });
  ipcMain.handle(IPC.queueStatus, () => queue.status());
  ipcMain.handle(IPC.queueStart, (_e, req: QueueStartRequest) => {
    if (queue.isRunning()) return { ok: false, error: 'Черга вже виконується' };
    const s = store.settings.schedule;
    const ok = queue.start({
      pcIds: (req.pcIds ?? []).map(Number),
      mode: req.mode === 'manual' ? 'manual' : 'test',
      concurrency: s.maxConcurrentUpdates,
      zoneOrder: s.zoneOrder,
      reason: 'запуск адміністратора',
    });
    return ok ? { ok } : { ok, error: 'Черга вже виконується' };
  });
  ipcMain.handle(IPC.queueCancel, () => queue.cancel());
  ipcMain.handle(IPC.agentBundled, () => readBundledSource(agentPackageDir()).catch(() => null));
  ipcMain.handle(IPC.agentPick, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Виберіть VadeAgent.exe',
      properties: ['openFile'],
      filters: [{ name: 'VadeAgent', extensions: ['exe'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = await fileSource(r.filePaths[0]);
    pickedSources.set(src.path, src);
    return src;
  });
  ipcMain.handle(IPC.agentUpdateStart, async (_e, req: AgentUpdateRequest) => {
    try {
      const src = req.source === 'bundled' ? await readBundledSource(agentPackageDir()) : pickedSources.get(req.source);
      if (!src) return { ok: false, error: 'Файл агента не знайдено' };
      await updater.start((req.pcIds ?? []).map(Number), src, req.includeSameVersion === true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.agentUpdateCancel, () => updater.cancel());
  ipcMain.handle(IPC.agentUpdateStatus, () => updater.status());
  ipcMain.handle(IPC.siteStatus, () => site.status());
  ipcMain.handle(IPC.siteTest, (_e, url: string, token: string) => site.test(String(url ?? ''), String(token ?? '')));
  ipcMain.handle(IPC.logsGet, (_e, id: number) => hub.getLogs(Number(id)));
  ipcMain.handle(IPC.steamLogin, (_e, req: SteamLoginRequest) => hub.steamLogin(req));
  ipcMain.handle(IPC.scan, (e) =>
    scanNetwork(store.settings.network.subnet, store.settings.network.agentPort, (p) => e.sender.send(IPC.scanProgress, p)),
  );
  ipcMain.handle(IPC.exportAgent, () => (win ? exportAgentPackage(win, store) : { ok: false }));
  ipcMain.handle(IPC.openData, async () => {
    await shell.openPath(store.dir);
  });

  /* ---------------- window ---------------- */
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Vade Launcher',
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') win?.webContents.reload();
  });
  win.on('close', (e) => {
    if (isQuitting || !store.settings.ui.closeToTray) return;
    e.preventDefault();
    win?.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        title: 'Vade Launcher працює у фоні',
        content: 'Нічний Wake-on-LAN і моніторинг активні. Вихід — через меню значка в треї.',
        iconType: 'info',
      });
    }
  });
  win.on('session-end', () => {
    isQuitting = true;
  });
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show();
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let cleanedUp = false;
  const cleanupAll = () => {
    isQuitting = true;
    if (cleanedUp) return;
    cleanedUp = true;
    if (tray) {
      try {
        tray.destroy();
      } catch {
        // ignore
      }
      tray = null;
    }
    discovery.stop();
    wol.stop();
    site.stop();
    queue.cancel();
    updater.cancel();
    void updater.server.stop();
    hub.stopAll();
  };

  /* ---------------- tray ---------------- */
  tray = new Tray(appIcon(16));
  tray.setToolTip('Vade Launcher');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Відкрити Vade Launcher', click: showWindow },
      { type: 'separator' },
      {
        label: 'Вийти (нічний WoL зупиниться)',
        click: () => {
          cleanupAll();
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);

  hub.sync();
  discovery.start();
  wol.start();
  site.start();
  applyAutostart(store.settings.ui.autostart);

  app.on('before-quit', () => {
    cleanupAll();
  });
  app.on('will-quit', () => {
    cleanupAll();
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => {
      cleanupAll();
      app.quit();
    });
  }
  app.on('window-all-closed', () => {
    if (isQuitting || !store.settings.ui.closeToTray) app.quit();
  });
}
