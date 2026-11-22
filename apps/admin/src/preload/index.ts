import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type VadeApi } from '../shared/api';

function subscribe<T>(channel: string) {
  return (cb: (value: T) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const api: VadeApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (s) => ipcRenderer.invoke(IPC.settingsSave, s),
  regenerateClubKey: () => ipcRenderer.invoke(IPC.settingsRegenKey),
  listPcs: () => ipcRenderer.invoke(IPC.pcsList),
  savePc: (pc, originalId) => ipcRenderer.invoke(IPC.pcsSave, pc, originalId),
  deletePcs: (ids) => ipcRenderer.invoke(IPC.pcsDelete, ids),
  getMapLayout: () => ipcRenderer.invoke(IPC.mapGet),
  saveMapLayout: (layout) => ipcRenderer.invoke(IPC.mapSave, layout),
  exportMapLayout: (layout) => ipcRenderer.invoke(IPC.mapExport, layout),
  importMapLayout: () => ipcRenderer.invoke(IPC.mapImport),
  getRuntimes: () => ipcRenderer.invoke(IPC.runtimesGet),
  runAction: (action, ids, opts) => ipcRenderer.invoke(IPC.actionRun, action, ids, opts ?? {}),
  getLogs: (id) => ipcRenderer.invoke(IPC.logsGet, id),
  steamLogin: (req) => ipcRenderer.invoke(IPC.steamLogin, req),
  scan: () => ipcRenderer.invoke(IPC.scan),
  exportAgentPackage: () => ipcRenderer.invoke(IPC.exportAgent),
  openDataDir: () => ipcRenderer.invoke(IPC.openData),
  getSiteStatus: () => ipcRenderer.invoke(IPC.siteStatus),
  testSite: (url, token) => ipcRenderer.invoke(IPC.siteTest, url, token),
  onSiteStatus: subscribe(IPC.siteUpdate),
  getQueueStatus: () => ipcRenderer.invoke(IPC.queueStatus),
  startQueue: (req) => ipcRenderer.invoke(IPC.queueStart, req),
  cancelQueue: () => ipcRenderer.invoke(IPC.queueCancel),
  onQueueStatus: subscribe(IPC.queueUpdate),
  getBundledAgent: () => ipcRenderer.invoke(IPC.agentBundled),
  pickAgentFile: () => ipcRenderer.invoke(IPC.agentPick),
  startAgentUpdate: (req) => ipcRenderer.invoke(IPC.agentUpdateStart, req),
  cancelAgentUpdate: () => ipcRenderer.invoke(IPC.agentUpdateCancel),
  getAgentUpdateStatus: () => ipcRenderer.invoke(IPC.agentUpdateStatus),
  onAgentUpdateStatus: subscribe(IPC.agentUpdateUpdate),
  onRuntimes: subscribe(IPC.runtimesUpdate),
  onLogs: subscribe(IPC.logsAppend),
  onScanProgress: subscribe(IPC.scanProgress),
  onPcsChanged: subscribe(IPC.pcsChanged),
  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  onHistoryChanged: subscribe(IPC.historyUpdate),
};

contextBridge.exposeInMainWorld('vade', api);
