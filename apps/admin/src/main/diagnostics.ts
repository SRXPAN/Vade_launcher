/**
 * Builds a single secret-redacted diagnostics ZIP bundle for support or troubleshooting.
 */
import os from 'node:os';
import { dialog, shell, type BrowserWindow } from 'electron';
import type { AppSettings, DiagBundleResult, JobHistoryEntry, PcRecord, PcRuntime } from '@vade/protocol';
import type { UiLogLine } from '../shared/api';
import { writeZipFile, type ZipEntry } from './zip';

export const REDACTED = '***REDACTED***';

export function redactAdminSettings(settings: AppSettings): AppSettings {
  const copy = structuredClone(settings);
  if (copy.security.clubKey) copy.security.clubKey = REDACTED;
  if (copy.security.pinHash) copy.security.pinHash = REDACTED;
  if (copy.site.token) copy.site.token = REDACTED;
  return copy;
}

export function redactTextSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join(REDACTED);
  }
  return out;
}

export interface DiagnosticsBuildInput {
  appVersion: string;
  settings: AppSettings;
  pcs: PcRecord[];
  history: JobHistoryEntry[];
  runtimes: PcRuntime[];
  localIps: string[];
  getLogs: (pcId: number) => UiLogLine[];
  pcId?: number;
  agentBundle?: DiagBundleResult | null;
  agentBundleError?: string;
}

export function buildDiagnosticsEntries(input: DiagnosticsBuildInput): ZipEntry[] {
  const secrets = [input.settings.security.clubKey, input.settings.security.pinHash, input.settings.site.token];
  const redactedSettings = redactAdminSettings(input.settings);
  const fmtLines = (lines: UiLogLine[]) =>
    redactTextSecrets(
      lines.map((l) => `[${l.ts}] ${l.admin ? '[ADMIN] ' : ''}${l.level.toUpperCase()} ${l.msg}`).join('\n'),
      secrets,
    );

  const entries: ZipEntry[] = [
    {
      name: 'admin/info.json',
      data: JSON.stringify(
        {
          collectedAt: new Date().toISOString(),
          appVersion: input.appVersion,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          hostname: os.hostname(),
          localIps: input.localIps,
          targetPcId: input.pcId ?? null,
        },
        null,
        2,
      ),
    },
    { name: 'admin/settings.json', data: JSON.stringify(redactedSettings, null, 2) },
    { name: 'admin/pcs.json', data: JSON.stringify(input.pcs, null, 2) },
    { name: 'admin/history.json', data: JSON.stringify(input.history.slice(0, 500), null, 2) },
    { name: 'admin/runtimes.json', data: JSON.stringify(input.runtimes, null, 2) },
  ];

  if (input.pcId != null) {
    const id = input.pcId;
    entries.push({ name: `pc-${id}/admin-logs.txt`, data: fmtLines(input.getLogs(id)) || '(порожньо)' });
    const rt = input.runtimes.find((r) => r.pcId === id) ?? null;
    entries.push({ name: `pc-${id}/runtime.json`, data: JSON.stringify(rt, null, 2) });

    if (input.agentBundle) {
      const b = input.agentBundle;
      entries.push({
        name: `pc-${id}/agent-config.json`,
        data: redactTextSecrets(JSON.stringify(b.agentConfig, null, 2), secrets),
      });
      entries.push({
        name: `pc-${id}/agent-system.json`,
        data: JSON.stringify(
          {
            collectedAt: b.collectedAt,
            hostname: b.hostname,
            agentVersion: b.agentVersion,
            os: b.os,
            ...b.systemInfo,
          },
          null,
          2,
        ),
      });
      entries.push({ name: `pc-${id}/agent.log`, data: redactTextSecrets(b.agentLog || '(порожньо)', secrets) });
      entries.push({ name: `pc-${id}/steamcmd-last.txt`, data: redactTextSecrets(b.steamcmdLast || '(порожньо)', secrets) });
    } else if (input.agentBundleError) {
      entries.push({ name: `pc-${id}/agent-bundle-error.txt`, data: input.agentBundleError });
    }
  } else {
    const allLogs = input.pcs
      .map((p) => `=== PC #${p.id} (${p.ip}, ${p.zone}) ===\n${fmtLines(input.getLogs(p.id).slice(-100)) || '(порожньо)'}`)
      .join('\n\n');
    entries.push({ name: 'admin/all-pc-logs.txt', data: allLogs || '(порожньо)' });
  }

  return entries;
}

export async function exportDiagnosticsZip(
  win: BrowserWindow,
  deps: {
    appVersion: string;
    settings: AppSettings;
    pcs: PcRecord[];
    history: JobHistoryEntry[];
    runtimes: PcRuntime[];
    localIps: string[];
    getLogs: (pcId: number) => UiLogLine[];
    collectAgentBundle: (pcId: number) => Promise<DiagBundleResult>;
  },
  pcId?: number,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const defaultName = pcId != null ? `vade-diag-pc${pcId}-${stamp}.zip` : `vade-diag-club-${stamp}.zip`;
  const pick = await dialog.showSaveDialog(win, {
    title: 'Зберегти діагностику (.zip)',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP архів', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false };

  let agentBundle: DiagBundleResult | null = null;
  let agentBundleError: string | undefined;
  if (pcId != null) {
    try {
      agentBundle = await deps.collectAgentBundle(pcId);
    } catch (e) {
      agentBundleError = e instanceof Error ? e.message : String(e);
    }
  }

  const entries = buildDiagnosticsEntries({
    appVersion: deps.appVersion,
    settings: deps.settings,
    pcs: deps.pcs,
    history: deps.history,
    runtimes: deps.runtimes,
    localIps: deps.localIps,
    getLogs: deps.getLogs,
    pcId,
    agentBundle,
    agentBundleError,
  });

  await writeZipFile(pick.filePath, entries);
  shell.showItemInFolder(pick.filePath);
  return { ok: true, path: pick.filePath };
}
