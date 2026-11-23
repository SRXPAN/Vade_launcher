import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain, Menu, nativeTheme, shell, Tray } from 'electron';
import type { AppSettings, AuditAction, DiagNotifyArgs, PcRecord, RestartLauncherApp, ThemeMode } from '@vade/protocol';
import { app, dialog } from 'electron';
import { requiresOwnerForAction, RoleController } from '../shared/access';
import {
  IPC,
  type ActionOptions,
  type AgentUpdateRequest,
  type DeployExecRequest,
  type DeployFileRequest,
  type PcAction,
  type PcServiceNoteInput,
  type QueueStartRequest,
  type SteamLoginRequest,
} from '../shared/api';
import { sanitizeMapLayout } from '../shared/mapLayout';
import { agentPackageAvailable, agentPackageDir, exportAgentPackage, exportAgentZip } from './agentPackage';
import { AgentUpdater, fileSource, readBundledSource, sha256OfFile } from './agentUpdater';
import { AuditStore } from './audit';
import { AutoBackupScheduler, exportBackupDialog, importBackupDialog } from './backup';
import { DeployManager } from './deploy';
import { exportDiagnosticsZip } from './diagnostics';
import { AdminDiscoveryListener } from './discovery';
import { AgentHub } from './hub';
import { appIcon } from './icon';
import { MaintenanceQueue } from './maintenanceQueue';
import { localIpv4, scanNetwork } from './scanner';
import { WolScheduler } from './scheduler';
import { SitePublisher } from './sitePublisher';
import { AdminStore } from './store';
import { AppUpdater } from './updater';

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
  const audit = new AuditStore(path.join(store.dir, 'audit.json'));
  const operatorFile = path.join(store.dir, 'operator.json');
  const readOperatorName = (): string => {
    try {
      const parsed = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as { name?: unknown };
      return typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 60) : '';
    } catch {
      return '';
    }
  };
  const saveOperatorName = (name: string) => {
    try {
      fs.writeFileSync(operatorFile, JSON.stringify({ name }, null, 2));
    } catch {
      // advisory
    }
  };
  const role = new RoleController({
    isPinEnabled: () => Boolean((store.settings.security.pinHash ?? '').trim()),
    verifyPin: (pin) => store.verifyPin(pin),
    getSessionMin: () => store.settings.security.ownerSessionMin,
    initialOperatorName: readOperatorName(),
    onOperatorNameSaved: saveOperatorName,
    onAudit: (action, details) => {
      audit.record({ role: 'owner', operatorName: role.state().operatorName, action, targets: [], details });
    },
  });
  const recordAudit = (action: AuditAction, targets: Array<string | number> = [], details?: string) => {
    const st = role.state();
    audit.record({ role: st.role, operatorName: st.operatorName, action, targets, details });
  };
  const autoBackup = new AutoBackupScheduler(store, app.getVersion(), (iso) => {
    store.setLastAutoBackupAt(iso);
  });
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
  const deploy = new DeployManager({
    runtime: (id) => hub.runtime(id),
    localAddressOf: (id) => hub.localAddressOf(id),
    deployExec: (id, args) => hub.deployExec(id, args),
    deployFile: (id, args) => hub.deployFile(id, args),
    log: (id, level, msg) => hub.adminLog(id, level, msg),
  });
  const appUpdater = new AppUpdater(app.getVersion());
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
  audit.on('changed', (entries) => win?.webContents.send(IPC.auditUpdate, entries));
  role.on('changed', (st) => win?.webContents.send(IPC.roleChanged, st));
  site.on('status', (s) => win?.webContents.send(IPC.siteUpdate, s));
  queue.on('status', (s) => win?.webContents.send(IPC.queueUpdate, s));
  updater.on('status', (s) => win?.webContents.send(IPC.agentUpdateUpdate, s));
  deploy.on('status', (s) => win?.webContents.send(IPC.deployUpdate, s));
  appUpdater.on('state', (s) => win?.webContents.send(IPC.appUpdateChanged, s));

  /* ---------------- IPC ---------------- */
  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    dataDir: store.dir,
    localIps: localIpv4().map((x) => x.ip),
    agentPackageAvailable: agentPackageAvailable(),
  }));
  ipcMain.handle(IPC.settingsGet, () => store.settings);
  ipcMain.handle(IPC.settingsSave, (_e, next: AppSettings) => {
    role.requireOwner('settings.edit');
    const prev = store.settings;
    const saved = store.saveSettings(next);
    if (prev.ui.autostart !== saved.ui.autostart) applyAutostart(saved.ui.autostart);
    if (prev.ui.theme !== saved.ui.theme) nativeTheme.themeSource = saved.ui.theme;
    hub.sync();
    hub.pushConfigAll();
    discovery.reconfigure();
    // Only site settings changes force a new request; other edits must not spend the daily budget.
    if (JSON.stringify(prev.site) !== JSON.stringify(saved.site)) site.reconfigure();
    if (JSON.stringify(prev.backup) !== JSON.stringify(saved.backup)) autoBackup.reconfigure();
    if (prev.security.ownerSessionMin !== saved.security.ownerSessionMin) role.syncPinConfig();
    recordAudit('settings.save');
    return saved;
  });
  ipcMain.handle(IPC.uiSetTheme, (_e, theme: ThemeMode) => {
    const saved = store.setThemeOnly(theme);
    nativeTheme.themeSource = saved.ui.theme;
    return saved;
  });
  ipcMain.handle(IPC.settingsRegenKey, () => {
    role.requireOwner('settings.edit');
    const saved = store.regenerateKey();
    hub.sync();
    recordAudit('settings.regen_key');
    return saved;
  });
  ipcMain.handle(IPC.pinSet, (_e, currentPin: string | undefined, newPin: string | null) => {
    if (role.state().pinEnabled) role.requireOwner('settings.edit');
    const res = store.setPin(currentPin, newPin);
    if (res.ok) {
      role.syncPinConfig();
      recordAudit('settings.pin_change', [], newPin == null ? 'disabled' : 'updated');
    }
    return res;
  });
  ipcMain.handle(IPC.pinVerify, (_e, pin: string) => store.verifyPin(String(pin ?? '')));
  ipcMain.handle(IPC.roleGet, () => role.state());
  ipcMain.handle(IPC.roleUnlock, (_e, pin: string) => role.unlock(String(pin ?? '')));
  ipcMain.handle(IPC.roleLock, () => role.lock('manual'));
  ipcMain.handle(IPC.roleSetOperator, (_e, name: string) => role.setOperatorName(String(name ?? '')));
  ipcMain.handle(IPC.auditList, () => audit.list());
  ipcMain.handle(IPC.auditLog, (_e, action: AuditAction, targets: string[], details?: string) => {
    recordAudit(action, Array.isArray(targets) ? targets : [], details);
  });
  ipcMain.handle(IPC.pcsList, () => store.pcs);
  ipcMain.handle(IPC.pcsSave, (_e, pc: PcRecord, originalId: number | null) => {
    role.requireOwner('pc.edit');
    const r = store.savePc(pc, originalId);
    if (!r.ok) return r;
    hub.sync();
    void hub.pushConfig(Number(pc.id)).catch(() => undefined);
    site.notifyChange();
    recordAudit('pc.save', [Number(pc.id)], originalId == null ? 'created' : 'updated');
    return { ok: true, pcs: store.pcs };
  });
  ipcMain.handle(IPC.pcsDelete, (_e, ids: number[]) => {
    role.requireOwner('pc.edit');
    const numIds = ids.map(Number);
    store.deletePcs(numIds);
    hub.sync();
    site.notifyChange();
    recordAudit('pc.delete', numIds);
    return store.pcs;
  });
  ipcMain.handle(IPC.pcSetServiceNote, (_e, pcId: number, note: PcServiceNoteInput | null) => {
    const id = Number(pcId);
    const prev = store.pcs.find((p) => p.id === id);
    const prevOut = Boolean(prev?.serviceNote?.outOfService);
    const st = role.state();
    const normalizedInput =
      note == null
        ? null
        : {
            outOfService: Boolean(note.outOfService),
            text: String(note.text ?? ''),
            author: note.author?.trim() || st.operatorName || undefined,
          };
    const updated = store.setServiceNote(id, normalizedInput);
    if (updated) {
      site.notifyChange();
      win?.webContents.send(IPC.pcsChanged, store.pcs);
      if (normalizedInput == null) recordAudit('pc.note_set', [id], 'cleared');
      else if (!prevOut && normalizedInput.outOfService) recordAudit('pc.repair_set', [id], normalizedInput.text);
      else if (prevOut && !normalizedInput.outOfService) recordAudit('pc.repair_clear', [id], normalizedInput.text);
      else recordAudit('pc.note_set', [id], normalizedInput.text);
    }
    return store.pcs;
  });
  ipcMain.handle(IPC.mapGet, () => store.mapLayout);
  ipcMain.handle(IPC.mapSave, (_e, layout: unknown) => {
    role.requireOwner('map.edit');
    const saved = store.saveMapLayout(layout);
    recordAudit('map.save');
    return saved;
  });
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
  ipcMain.handle(IPC.actionRun, async (_e, action: PcAction, ids: number[], opts?: ActionOptions) => {
    if (!ACTIONS.includes(action)) throw new Error(`Невідома дія ${action}`);
    const numIds = (ids ?? []).map(Number);
    const st = role.state();
    const occupiedCount = numIds.filter((id) => hub.runtime(id).status?.occupancy === 'occupied').length;
    if (requiresOwnerForAction({ pinEnabled: st.pinEnabled, role: st.role, action, occupiedCount, force: opts?.force === true })) {
      role.requireOwner('power.occupied');
    }
    const res = await hub.runAction(action, numIds, { force: opts?.force === true });
    const actionMap: Partial<Record<PcAction, AuditAction>> = {
      wake: 'pc.wol',
      shutdown: 'pc.shutdown',
      restart: 'pc.restart',
      sleep: 'pc.sleep',
      hibernate: 'pc.hibernate',
      'cancel-power': 'pc.cancel_power',
      test: 'pc.maintenance',
      run: 'pc.maintenance',
      cancel: 'pc.maintenance_cancel',
      'clean-logins': 'pc.clean',
      'sync-time': 'pc.sync_time',
    };
    const auditAct = actionMap[action];
    if (auditAct) recordAudit(auditAct, numIds, opts?.force ? 'force' : undefined);
    return res;
  });
  ipcMain.handle(IPC.queueStatus, () => queue.status());
  ipcMain.handle(IPC.queueStart, (_e, req: QueueStartRequest) => {
    if (queue.isRunning()) return { ok: false, error: 'Черга вже виконується' };
    const s = store.settings.schedule;
    const pcIds = (req.pcIds ?? []).map(Number);
    const ok = queue.start({
      pcIds,
      mode: req.mode === 'manual' ? 'manual' : 'test',
      concurrency: s.maxConcurrentUpdates,
      zoneOrder: s.zoneOrder,
      reason: 'запуск адміністратора',
    });
    if (ok) recordAudit('queue.start', pcIds, req.mode);
    return ok ? { ok } : { ok, error: 'Черга вже виконується' };
  });
  ipcMain.handle(IPC.queueCancel, () => {
    queue.cancel();
    recordAudit('queue.cancel');
  });
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
      role.requireOwner('agent.update');
      const src = req.source === 'bundled' ? await readBundledSource(agentPackageDir()) : pickedSources.get(req.source);
      if (!src) return { ok: false, error: 'Файл агента не знайдено' };
      const ids = (req.pcIds ?? []).map(Number);
      await updater.start(ids, src, req.includeSameVersion === true);
      recordAudit('agent.update', ids, src.version);
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
  ipcMain.handle(IPC.steamLogin, async (_e, req: SteamLoginRequest) => {
    const res = await hub.steamLogin(req);
    recordAudit('pc.steam_login', req.pcIds, req.user);
    return res;
  });
  ipcMain.handle(IPC.scan, (e) =>
    scanNetwork(store.settings.network.subnet, store.settings.network.agentPort, (p) => e.sender.send(IPC.scanProgress, p)),
  );
  ipcMain.handle(IPC.exportAgent, () => (win ? exportAgentPackage(win, store) : { ok: false }));
  ipcMain.handle(IPC.exportAgentZip, () => (win ? exportAgentZip(win, store) : { ok: false }));
  ipcMain.handle(IPC.gamesList, (_e, pcIds: number[]) => hub.listGames((pcIds ?? []).map(Number)));
  ipcMain.handle(IPC.gamesUninstall, async (_e, pcId: number, appId: number, libraryPath: string) => {
    const r = await hub.uninstallGame(Number(pcId), Number(appId), String(libraryPath ?? ''));
    if (r.ok) recordAudit('games.uninstall', [Number(pcId)], String(appId));
    return r;
  });
  ipcMain.handle(IPC.gamesInstall, async (_e, pcId: number, appId: number, libraryPath?: string) => {
    const r = await hub.installGame(Number(pcId), Number(appId), typeof libraryPath === 'string' && libraryPath ? libraryPath : undefined);
    if (r.ok) recordAudit('games.install', [Number(pcId)], String(appId));
    return r;
  });
  ipcMain.handle(IPC.diagProcesses, (_e, pcId: number) => hub.diagProcesses(Number(pcId)));
  ipcMain.handle(IPC.diagKillProcess, async (_e, pcId: number, pid: number) => {
    const id = Number(pcId);
    const res = await hub.diagKillProcess(id, Number(pid));
    if (res.ok) recordAudit('diag.kill', [id], `PID ${pid}`);
    return res;
  });
  ipcMain.handle(IPC.diagRestartExplorer, async (_e, pcId: number) => {
    const id = Number(pcId);
    const res = await hub.diagRestartExplorer(id);
    if (res.ok) recordAudit('diag.restart_explorer', [id]);
    return res;
  });
  ipcMain.handle(IPC.diagScreenshot, async (_e, pcId: number) => {
    const id = Number(pcId);
    const res = await hub.diagScreenshot(id);
    recordAudit('diag.screenshot', [id]);
    return res;
  });
  ipcMain.handle(IPC.diagNotify, async (_e, pcId: number, args: DiagNotifyArgs) => {
    const id = Number(pcId);
    const res = await hub.diagNotify(id, args);
    if (res.ok) recordAudit('diag.notify', [id], String(args?.message ?? '').slice(0, 80));
    return res;
  });
  ipcMain.handle(IPC.diagRestoreRefreshRate, async (_e, pcId: number, targetHz: number) => {
    const id = Number(pcId);
    const hz = Number(targetHz);
    const res = await hub.diagRestoreRefreshRate(id, hz);
    if (res.ok) recordAudit('diag.restore_hz', [id], `${hz} Hz`);
    return res;
  });
  ipcMain.handle(IPC.diagRestartLauncher, async (_e, pcId: number, launcherApp: RestartLauncherApp) => {
    const id = Number(pcId);
    const res = await hub.diagRestartLauncher(id, launcherApp);
    if (res.ok) recordAudit('diag.restart_launcher', [id], launcherApp);
    return res;
  });
  ipcMain.handle(IPC.diagExportZip, (_e, pcId?: number) =>
    win
      ? exportDiagnosticsZip(
          win,
          {
            appVersion: app.getVersion(),
            settings: store.settings,
            pcs: store.pcs,
            history: store.listHistory(),
            runtimes: hub.runtimes(),
            localIps: localIpv4().map((x) => x.ip),
            getLogs: (id) => hub.getLogs(id),
            collectAgentBundle: (id) => hub.collectDiagBundle(id),
          },
          pcId != null ? Number(pcId) : undefined,
        )
      : { ok: false },
  );
  ipcMain.handle(IPC.backupExport, async () => {
    if (!win) return { ok: false };
    try {
      role.requireOwner('backup');
      const r = await exportBackupDialog(win, store, app.getVersion());
      if (r.ok) recordAudit('backup.export', [], r.path);
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.backupImport, async () => {
    if (!win) return { ok: false };
    try {
      role.requireOwner('backup');
      const r = await importBackupDialog(win, store);
      if (r.ok) {
        hub.sync();
        hub.pushConfigAll();
        discovery.reconfigure();
        site.reconfigure();
        autoBackup.reconfigure();
        role.syncPinConfig();
        nativeTheme.themeSource = store.settings.ui.theme;
        win?.webContents.send(IPC.pcsChanged, store.pcs);
        recordAudit('backup.import', [], r.path);
        return { ...r, settings: store.settings, pcs: store.pcs };
      }
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.backupPickDir, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Папка для автобекапів',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.backupRunNow, async () => {
    try {
      role.requireOwner('backup');
      const r = await autoBackup.runNow();
      if (r.ok && r.path) recordAudit('backup.export', [], r.path);
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.backupStatus, () => autoBackup.status());
  ipcMain.handle(IPC.deployPickFile, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Виберіть файл для роздачі на ПК',
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const filePath = r.filePaths[0];
    return {
      path: filePath,
      name: path.basename(filePath),
      size: fs.statSync(filePath).size,
      sha256: await sha256OfFile(filePath),
    };
  });
  ipcMain.handle(IPC.deployExecStart, async (_e, req: DeployExecRequest) => {
    try {
      if (role.state().pinEnabled && role.state().role !== 'owner') {
        if (req.pin?.trim()) {
          const u = role.unlock(req.pin);
          if (!u.ok) return { ok: false, error: u.error ?? 'Невірний PIN-код адміністратора' };
        } else {
          role.requireOwner('deploy');
        }
      }
      const ids = (req.pcIds ?? []).map(Number);
      await deploy.startExec(ids, {
        shell: req.shell === 'cmd' ? 'cmd' : 'powershell',
        script: String(req.script ?? ''),
        timeoutSec: Number(req.timeoutSec) || 60,
      });
      recordAudit('deploy.exec', ids, req.shell);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.deployFileStart, async (_e, req: DeployFileRequest) => {
    try {
      if (role.state().pinEnabled && role.state().role !== 'owner') {
        if (req.pin?.trim()) {
          const u = role.unlock(req.pin);
          if (!u.ok) return { ok: false, error: u.error ?? 'Невірний PIN-код адміністратора' };
        } else {
          role.requireOwner('deploy');
        }
      }
      const ids = (req.pcIds ?? []).map(Number);
      await deploy.startFile(ids, String(req.localPath ?? ''), String(req.targetPath ?? ''));
      recordAudit('deploy.file', ids, req.targetPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC.deployCancel, () => deploy.cancel());
  ipcMain.handle(IPC.deployStatus, () => deploy.status());
  ipcMain.handle(IPC.appUpdateStatus, () => appUpdater.state);
  ipcMain.handle(IPC.appUpdateCheck, () => appUpdater.checkForUpdates());
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
    autoBackup.stop();
    role.stop();
    queue.cancel();
    updater.cancel();
    void updater.server.stop();
    deploy.stop();
    appUpdater.stop();
    hub.stopAll();
  };

  ipcMain.handle(IPC.appUpdateInstall, () => appUpdater.quitAndInstall(cleanupAll));

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
  autoBackup.start();
  applyAutostart(store.settings.ui.autostart);
  appUpdater.startAutoCheck();

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
