import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { parseCidr } from '@vade/protocol';
import { localIpv4 } from './scanner';
import type { AdminStore } from './store';
import { writeZipFile, type ZipEntry } from './zip';

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

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Picks the admin PC's IPv4 belonging to the club subnet, or first local IPv4. */
export function pickAdminLanIp(subnet: string, ips = localIpv4().map((x) => x.ip)): string {
  const parsed = parseCidr(subnet);
  if (parsed && ips.length > 0) {
    const match = ips.find((ip) => (ipToInt(ip) & parsed.mask) === parsed.network);
    if (match) return match;
  }
  return ips[0] ?? '';
}

const USB_FILES = [
  { name: 'VadeAgent.exe', store: true },
  { name: 'VadeAgentService.exe', store: true },
  { name: 'VadeAgentService.xml', store: false },
  { name: 'install.cmd', store: false },
  { name: 'install.ps1', store: false },
  { name: 'uninstall.cmd', store: false },
  { name: 'uninstall.ps1', store: false },
];

/** Builds a pure-Node preconfigured ZIP installer ("agent USB stick") with `preconfig.json`. */
export async function exportAgentZip(win: BrowserWindow, store: AdminStore): Promise<{ ok: boolean; path?: string; error?: string }> {
  const src = agentPackageDir();
  if (!agentPackageAvailable()) {
    return { ok: false, error: `Пакет агента не знайдено (${src}). Зберіть його командою: npm run build:agent` };
  }
  const pick = await dialog.showSaveDialog(win, {
    title: 'Зберегти інсталятор агента для цього клубу (.zip)',
    defaultPath: 'VadeAgent-Club-Installer.zip',
    filters: [{ name: 'ZIP архів', extensions: ['zip'] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false };

  const entries: ZipEntry[] = [];
  for (const f of USB_FILES) {
    const full = path.join(src, f.name);
    if (!fs.existsSync(full)) {
      if (f.name === 'VadeAgent.exe' || f.name === 'install.ps1' || f.name === 'install.cmd') {
        return { ok: false, error: `Відсутній обов'язковий файл у пакеті агента: ${f.name}` };
      }
      continue;
    }
    entries.push({ name: f.name, data: await fsp.readFile(full), store: f.store });
  }

  const { clubKey } = store.settings.security;
  const { agentPort, subnet } = store.settings.network;
  const adminIp = pickAdminLanIp(subnet);
  const preconfig = {
    clubKey,
    port: agentPort,
    adminIp,
    allowFrom: adminIp ? [adminIp] : [],
  };
  entries.push({ name: 'preconfig.json', data: JSON.stringify(preconfig, null, 2) });
  entries.push({
    name: 'README.txt',
    data: [
      'Vade Agent — готова флешка інсталятора для клубу',
      '',
      '1. Розпакуйте вміст цього архіву на флешку або скопіюйте на ігровий ПК.',
      '2. Двічі клацніть install.cmd (підтвердіть права адміністратора).',
      '   Усі налаштування (clubKey, порт, IP адмін-ПК) зчитаються автоматично з preconfig.json.',
      '3. У Vade Launcher ПК стане Online → виконайте для нього «Вхід SteamCMD».',
      '',
      `Адмін-ПК (allowFrom): ${adminIp || 'будь-який у підмережі'}`,
      'УВАГА: preconfig.json містить секретний ключ клубу. Видаліть архів/папку після встановлення.',
    ].join('\r\n'),
  });

  await writeZipFile(pick.filePath, entries);
  shell.showItemInFolder(pick.filePath);
  return { ok: true, path: pick.filePath };
}
