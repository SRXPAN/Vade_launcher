import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import type { AdminStore } from './store';

/** dist/package of apps/agent in development, resources/agent in the installed app. */
export function agentPackageDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'agent')
    : path.resolve(app.getAppPath(), '..', 'agent', 'dist', 'package');
}

export function agentPackageAvailable(): boolean {
  return fs.existsSync(path.join(agentPackageDir(), 'VadeAgent.exe'));
}

/**
 * Copies the agent installer to a folder (USB stick / network share) together with an
 * agent.json that contains the club key, so install.cmd works with a double click.
 */
export async function exportAgentPackage(win: BrowserWindow, store: AdminStore): Promise<{ ok: boolean; path?: string; error?: string }> {
  const src = agentPackageDir();
  if (!agentPackageAvailable()) {
    return { ok: false, error: `Пакет агента не знайдено (${src}). Зберіть його командою: npm run build:agent` };
  }
  const pick = await dialog.showOpenDialog(win, {
    title: 'Куди зберегти пакет агента',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false };
  const dest = path.join(pick.filePaths[0], 'VadeAgent-setup');
  await fsp.mkdir(dest, { recursive: true });
  await fsp.cp(src, dest, { recursive: true, force: true });
  const { clubKey } = store.settings.security;
  const { agentPort } = store.settings.network;
  await fsp.writeFile(path.join(dest, 'agent.json'), JSON.stringify({ clubKey, port: agentPort, allowFrom: [] }, null, 2));
  await fsp.writeFile(
    path.join(dest, 'README.txt'),
    [
      'Vade Agent — встановлення на ігровий ПК',
      '',
      '1. Скопіюйте цю папку на ігровий ПК (або запустіть з флешки / мережевої папки).',
      '2. Двічі клацніть install.cmd і підтвердьте права адміністратора.',
      '3. В адмін-панелі ПК стане Online. Виберіть його і виконайте «Вхід SteamCMD» (один раз).',
      '',
      'УВАГА: agent.json містить ключ клубу. Не залишайте цю папку на ігрових ПК',
      'і не передавайте стороннім — з ключем можна керувати всіма ПК клубу.',
      '',
      'Видалення: C:\\Program Files\\VadeAgent\\uninstall.cmd',
    ].join('\r\n'),
  );
  shell.showItemInFolder(path.join(dest, 'install.cmd'));
  return { ok: true, path: dest };
}
