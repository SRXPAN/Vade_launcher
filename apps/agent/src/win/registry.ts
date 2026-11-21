import fs from 'node:fs';
import path from 'node:path';
import type { Sys } from '../sys';
import { EXE, userProfileDirs } from './paths';
import { sleep } from '../util';

const TMP_HIVE = 'HKU\\VadeAgentTmp';

export interface RegistryCleanResult {
  cleaned: number;
  failed: number;
  hivesLoaded: number;
}

type KeyResult = 'cleaned' | 'absent' | 'failed';

/** Same as the old .bat: delete AutoLoginUser, set RememberPassword = 0. */
async function cleanSteamKey(sys: Sys, root: string): Promise<KeyResult> {
  const key = `${root}\\Software\\Valve\\Steam`;
  const q = await sys.exec(EXE.reg, ['query', key]);
  if (q.code !== 0) return 'absent';
  await sys.mutate(EXE.reg, ['delete', key, '/v', 'AutoLoginUser', '/f']); // fails harmlessly if missing
  const r = await sys.mutate(EXE.reg, ['add', key, '/v', 'RememberPassword', '/t', 'REG_DWORD', '/d', '0', '/f']);
  return r.code === 0 ? 'cleaned' : 'failed';
}

/**
 * Cleans Steam auto-login in the registry of ALL Windows users:
 *  1) users whose hive is loaded now (HKU\S-1-5-21-...),
 *  2) users who are logged out: their NTUSER.DAT is loaded temporarily.
 * A hive that cannot be loaded belongs to a logged-in user and was handled in step 1.
 */
export async function cleanSteamRegistryAllUsers(
  sys: Sys,
  log: (msg: string) => void,
  opts: { offlineHives?: boolean } = {},
): Promise<RegistryCleanResult> {
  const res: RegistryCleanResult = { cleaned: 0, failed: 0, hivesLoaded: 0 };
  const tally = (r: KeyResult) => {
    if (r === 'cleaned') res.cleaned++;
    else if (r === 'failed') res.failed++;
  };

  const q = await sys.exec(EXE.reg, ['query', 'HKU']);
  const loaded = q.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^HKEY_USERS\\S-1-5-21-[\d-]+$/i.test(l));
  for (const key of loaded) tally(await cleanSteamKey(sys, key));

  // The quick clean after a session only needs the logged-in user (loaded hive) and must stay fast.
  if (opts.offlineHives === false) return res;

  if (sys.dryRun) {
    const offline = userProfileDirs().filter((d) => fs.existsSync(path.join(d, 'NTUSER.DAT')));
    log(`[dry-run] реєстр неактивних профілів (${offline.length}) не підвантажується`);
    return res;
  }

  await sys.exec(EXE.reg, ['unload', TMP_HIVE]); // leftover after a crash
  for (const dir of userProfileDirs()) {
    const hive = path.join(dir, 'NTUSER.DAT');
    if (!fs.existsSync(hive)) continue;
    const load = await sys.exec(EXE.reg, ['load', TMP_HIVE, hive]);
    if (load.code !== 0) continue; // in use by a logged-in user
    res.hivesLoaded++;
    try {
      tally(await cleanSteamKey(sys, TMP_HIVE));
    } finally {
      let unloaded = false;
      for (let i = 0; i < 5 && !unloaded; i++) {
        unloaded = (await sys.exec(EXE.reg, ['unload', TMP_HIVE])).code === 0;
        if (!unloaded) await sleep(1000);
      }
      if (!unloaded) log(`УВАГА: не вдалося вивантажити тимчасовий hive ${hive}`);
    }
  }
  return res;
}
