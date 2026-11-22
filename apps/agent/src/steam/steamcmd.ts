import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateStatus, SteamLoginResult } from '@vade/protocol';
import type { Sys } from '../sys';
import { EXE } from '../win/paths';

export const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';

/** Returns the path of steamcmd.exe, downloading SteamCMD first if needed. */
export async function ensureSteamcmd(
  sys: Sys,
  dir: string,
  signal: AbortSignal | undefined,
  log: (msg: string) => void,
): Promise<string | null> {
  const exe = path.join(dir, 'steamcmd.exe');
  if (fs.existsSync(exe)) return exe;
  if (sys.dryRun) {
    log(`[dry-run] SteamCMD не знайдено в ${dir} — завантаження пропущено`);
    return null;
  }
  log(`SteamCMD не знайдено — завантаження в ${dir}`);
  await fsp.mkdir(dir, { recursive: true });
  const zip = path.join(dir, 'steamcmd.zip');
  const res = await fetch(STEAMCMD_URL, { signal });
  if (!res.ok) throw new Error(`завантаження SteamCMD: HTTP ${res.status}`);
  await fsp.writeFile(zip, Buffer.from(await res.arrayBuffer()));
  const r = await sys.exec(EXE.tar, ['-xf', zip, '-C', dir]);
  await fsp.rm(zip, { force: true });
  if (r.code !== 0) throw new Error(`розпакування SteamCMD: ${r.stderr.trim()}`);
  return fs.existsSync(exe) ? exe : null;
}

/* ------------------------------------------------------------------ */
/* Output parsing                                                      */
/* ------------------------------------------------------------------ */

export interface SteamProgress {
  phase: string;
  pct: number;
  done: number;
  total: number;
}

const PROGRESS_RE = /Update state \(0x[0-9a-f]+\) ([a-z ]+?), progress: ([\d.]+) \((\d+) \/ (\d+)\)/i;

export function parseProgress(line: string): SteamProgress | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  return { phase: m[1].trim(), pct: Number(m[2]), done: Number(m[3]), total: Number(m[4]) };
}

export interface AppLineResult {
  appId: number;
  status: AppUpdateStatus;
  message?: string;
}

const NO_SUBSCRIPTION_RE =
  /no subscription|no license|invalid platform|missing configuration|access denied|subscription required|not owned|region locked/i;

function noSubscriptionResult(appId: number, reason: string): AppLineResult {
  const clean = reason.trim();
  const message = /^no subscription$/i.test(clean) ? 'клубний акаунт не має цієї гри' : `немає доступу (${clean})`;
  return { appId, status: 'skipped_no_subscription', message };
}

export function parseAppResultLine(line: string): AppLineResult | null {
  let m = /Success! App '(\d+)' (fully installed|already up to date)/i.exec(line);
  if (m) return { appId: Number(m[1]), status: 'ok', message: /already/i.test(m[2]) ? 'вже актуальна' : 'оновлено' };
  m = /Failed to install app '(\d+)' \(([^)]*)\)/i.exec(line);
  if (m) {
    if (NO_SUBSCRIPTION_RE.test(m[2])) return noSubscriptionResult(Number(m[1]), m[2]);
    return { appId: Number(m[1]), status: 'error', message: m[2] };
  }
  m = /'(\d+)' \(([^)]*)\)/i.exec(line);
  if (m && NO_SUBSCRIPTION_RE.test(m[2])) return noSubscriptionResult(Number(m[1]), m[2]);
  return null;
}

const LOGIN_ERRORS: Array<[RegExp, string]> = [
  [/Cached credentials not found/i, 'немає збережених облікових даних SteamCMD'],
  [/Invalid Password/i, 'невірний пароль Steam'],
  [/to Steam Public\.\.\.FAILED/i, 'вхід у Steam не вдався'],
  [/FAILED login with result code/i, 'вхід у Steam не вдався'],
  [/Login Failure/i, 'вхід у Steam не вдався'],
  [/Not logged on/i, 'SteamCMD не увійшов у Steam'],
];

export function detectLoginError(output: string): string | null {
  for (const [re, msg] of LOGIN_ERRORS) if (re.test(output)) return msg;
  return null;
}

/** Final verdict for one app after SteamCMD exited. */
export function classifyApp(output: string, appId: number, loginError: boolean): AppLineResult {
  for (const line of output.split(/\r?\n/)) {
    const r = parseAppResultLine(line);
    if (r && r.appId === appId) return r;
  }
  if (loginError) return { appId, status: 'login_error', message: 'помилка входу SteamCMD' };
  return { appId, status: 'error', message: 'SteamCMD не підтвердив оновлення (див. steamcmd-last.txt)' };
}

export const GUARD_PROMPT_RE = /(Steam Guard code|Two-factor code|two factor code|Enter the current code)[^\n]*:\s*$/i;

export function classifySteamLogin(output: string): SteamLoginResult {
  const last = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (/Rate Limit Exceeded/i.test(output)) return { outcome: 'rate_limited', message: 'Steam тимчасово обмежив спроби входу. Спробуйте пізніше.' };
  if (/Invalid Password/i.test(output)) return { outcome: 'invalid_password', message: 'Невірний пароль.' };
  if (/to Steam Public\.\.\.OK|Waiting for user info\.\.\.OK/i.test(output)) return { outcome: 'ok', message: 'Вхід виконано, облікові дані збережено.' };
  if (/Two-factor code mismatch|Invalid Login Auth Code|TwoFactorCodeMismatch|InvalidLoginAuthCode/i.test(output)) {
    return { outcome: 'guard_mismatch', message: 'Код Steam Guard не підійшов. Введіть новий код.' };
  }
  if (/Steam Guard|two.factor|Account Logon Denied|AccountLogonDenied|Enter the current code/i.test(output)) {
    return { outcome: 'guard_required', message: 'Потрібен код Steam Guard (із пошти або застосунку).' };
  }
  return { outcome: 'error', message: last || 'Невідома помилка SteamCMD' };
}

/* ------------------------------------------------------------------ */
/* Running SteamCMD                                                    */
/* ------------------------------------------------------------------ */

export interface SteamcmdRun {
  /** Output without progress lines (they are only in the raw file) */
  output: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface SteamcmdOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  /** Full raw output is appended here (like last_output.txt of the old .bat) */
  rawFile?: string;
  /** Strings that must never reach logs or files (the password) */
  redact?: string[];
  onLine?: (line: string) => void;
  /** Checked after every chunk; true kills SteamCMD (used for interactive prompts) */
  shouldStop?: (output: string, partialLine: string) => boolean;
}

export function runSteamcmd(exe: string, args: string[], opts: SteamcmdOptions): Promise<SteamcmdRun> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin?.end();
    let output = '';
    let partial = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const raw = opts.rawFile ? fs.createWriteStream(opts.rawFile, { flags: 'a' }) : null;
    raw?.on('error', () => undefined);

    const redact = (s: string) => {
      for (const secret of opts.redact ?? []) if (secret) s = s.split(secret).join('***');
      return s;
    };
    const kill = () => {
      if (child.pid && child.exitCode === null) {
        spawn(EXE.taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      }
    };
    const onData = (buf: Buffer) => {
      const s = redact(buf.toString('utf8'));
      raw?.write(s);
      partial += s;
      const parts = partial.split(/\r\n|\n|\r/);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        if (!PROGRESS_RE.test(line)) output += `${line}\n`;
        opts.onLine?.(line);
      }
      if (opts.shouldStop?.(output, partial)) kill();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (partial.trim()) {
        output += `${partial}\n`;
        opts.onLine?.(partial);
      }
      raw?.end();
      resolve({ output, code, timedOut, aborted });
    };
    child.on('error', (e) => {
      output += `spawn error: ${e.message}\n`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
