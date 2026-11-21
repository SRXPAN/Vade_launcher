/**
 * Removes what keeps a browser signed in — cookies, saved passwords, open sessions and site storage
 * (Local/Session Storage, IndexedDB: Telegram Web, WhatsApp Web, FACEIT keep their login there) —
 * so the next client cannot open the previous client's Gmail, YouTube or FACEIT.
 * Bookmarks, extensions, settings and the browser itself stay.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserId } from '@vade/protocol';
import type { RemoveStats, Sys } from '../sys';

/** Chromium profile (Chrome, Edge, Opera): files and folders relative to the profile folder. */
export const CHROMIUM_SESSION_ITEMS = [
  'Cookies',
  'Cookies-journal',
  'Network\\Cookies',
  'Network\\Cookies-journal',
  'Extension Cookies',
  'Extension Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Web Data',
  'Web Data-journal',
  'Local Storage',
  'Session Storage',
  'Sessions',
  'IndexedDB',
  'Current Session',
  'Current Tabs',
  'Last Session',
  'Last Tabs',
];

/**
 * Firefox profile. Only storage\default and storage\temporary (web sites);
 * storage\permanent holds extension data and stays.
 */
export const FIREFOX_SESSION_ITEMS = [
  'cookies.sqlite',
  'cookies.sqlite-wal',
  'cookies.sqlite-shm',
  'logins.json',
  'logins-backup.json',
  'sessionstore.jsonlz4',
  'sessionstore-backups',
  'webappsstore.sqlite',
  'webappsstore.sqlite-wal',
  'webappsstore.sqlite-shm',
  'storage\\default',
  'storage\\temporary',
];

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** A Chromium profile folder has a Preferences file (Default, Profile 1, Guest Profile …). */
function chromiumProfilesIn(userDataDir: string): string[] {
  return subdirs(userDataDir).filter((d) => fs.existsSync(path.join(d, 'Preferences')));
}

/** Opera keeps the main profile in the root folder and extra ones in _side_profiles. */
function operaProfilesIn(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, 'Preferences'))) out.push(root);
  out.push(...chromiumProfilesIn(path.join(root, '_side_profiles')));
  return out;
}

/** Profile folders of one browser for one Windows user folder (C:\Users\<name>). */
export function browserProfileDirs(userDir: string, browser: BrowserId): string[] {
  const local = path.join(userDir, 'AppData', 'Local');
  const roaming = path.join(userDir, 'AppData', 'Roaming');
  switch (browser) {
    case 'chrome':
      return chromiumProfilesIn(path.join(local, 'Google', 'Chrome', 'User Data'));
    case 'edge':
      return chromiumProfilesIn(path.join(local, 'Microsoft', 'Edge', 'User Data'));
    case 'opera':
      return [
        ...operaProfilesIn(path.join(roaming, 'Opera Software', 'Opera Stable')),
        ...operaProfilesIn(path.join(roaming, 'Opera Software', 'Opera GX Stable')),
      ];
    case 'firefox':
      return subdirs(path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'));
  }
}

export function browserSessionItems(browser: BrowserId): string[] {
  return browser === 'firefox' ? FIREFOX_SESSION_ITEMS : CHROMIUM_SESSION_ITEMS;
}

export interface BrowserCleanResult extends RemoveStats {
  profiles: number;
  /** Browsers where at least one profile was found */
  found: BrowserId[];
}

/** The browsers must be closed before (their files are locked while running). */
export async function cleanBrowserSessions(sys: Sys, userDirs: string[], browsers: BrowserId[]): Promise<BrowserCleanResult> {
  const res: BrowserCleanResult = { removed: 0, failed: 0, profiles: 0, found: [] };
  for (const browser of browsers) {
    const items = browserSessionItems(browser);
    for (const userDir of userDirs) {
      for (const profile of browserProfileDirs(userDir, browser)) {
        res.profiles++;
        if (!res.found.includes(browser)) res.found.push(browser);
        for (const item of items) {
          const s = await sys.removeTree(path.join(profile, item));
          res.removed += s.removed;
          res.failed += s.failed;
        }
      }
    }
  }
  return res;
}
