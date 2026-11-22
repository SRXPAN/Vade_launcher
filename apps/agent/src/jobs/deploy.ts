import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ERR_HASH, type DeployExecArgs, type DeployExecResult, type DeployFileArgs, type DeployFileResult } from '@vade/protocol';
import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { AgentError } from '../util';
import { EXE } from '../win/paths';

const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_DEPLOY_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function capText(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n[...обрізано понад ${MAX_OUTPUT_CHARS} символів...]`;
}

/** Executes a PowerShell or CMD script on the PC with UTF-8 output decoding and timeout cap. */
export async function execDeployCommand(sys: Sys, log: Logger, args: DeployExecArgs): Promise<DeployExecResult> {
  const shell = args.shell === 'cmd' ? 'cmd' : 'powershell';
  const script = String(args.script ?? '');
  if (!script.trim()) throw new Error('Скрипт не може бути порожнім');
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('Скрипт завеликий (ліміт 64 КБ)');
  const timeoutSec = Math.max(1, Math.min(600, Math.round(Number(args.timeoutSec) || 60)));
  const timeoutMs = timeoutSec * 1000;

  log.info(`Deploy (${shell}, ліміт ${timeoutSec} с): ${script.trim().split(/\r?\n/)[0].slice(0, 120)}`);
  const started = Date.now();
  const res =
    shell === 'cmd'
      ? await sys.mutate(EXE.cmd, ['/d', '/c', script], timeoutMs, 'oem')
      : await sys.powershell(script, { mutating: true, timeoutMs });
  const durationMs = Date.now() - started;
  const timedOut = res.code === -1 && /timed out|timeout|ETIMEDOUT/i.test(res.stderr);

  return {
    exitCode: res.code,
    stdout: capText(res.stdout),
    stderr: capText(res.stderr),
    timedOut,
    durationMs,
  };
}

/** Validates destination path for `deploy.file`: must be an absolute non-root Windows path without traversal segments. */
export function validateDeployTargetPath(targetPath: string): string {
  const raw = String(targetPath ?? '').trim();
  if (!raw || raw.includes('\0')) throw new Error('Некоректний шлях призначення');
  if (raw.split(/[\\/]+/).some((seg) => seg === '..')) {
    throw new Error('Заборонено ".." у шляху призначення');
  }
  if (!path.win32.isAbsolute(raw)) {
    throw new Error(`Потрібен абсолютний шлях (напр. C:\\Games\\config.ini): ${raw}`);
  }
  const normalized = path.win32.normalize(raw);
  const parsed = path.win32.parse(normalized);
  if (normalized.replace(/\\+$/, '').toLowerCase() === parsed.root.replace(/\\+$/, '').toLowerCase()) {
    throw new Error('Корінь диска не може бути цільовим файлом');
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : normalized;
}

/**
 * Downloads a file over HTTP/HTTPS, verifies its SHA-256 hash against `expectedSha256`,
 * creates parent directories, and atomically moves it into `targetPath`.
 */
export async function downloadDeployFile(sys: Sys, log: Logger, args: DeployFileArgs): Promise<DeployFileResult> {
  let url: URL;
  try {
    url = new URL(String(args.url ?? ''));
  } catch {
    throw new Error('Некоректний URL файлу');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Некоректний протокол URL');
  const expected = String(args.sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Некоректний sha256');
  const target = validateDeployTargetPath(args.targetPath);

  log.info(`Deploy файлу → ${target} (sha256 ${expected.slice(0, 12)}…)`);
  if (sys.dryRun) {
    return { ok: true, bytes: 0, targetPath: target, message: `[dry-run] Файл буде збережено в ${target}` };
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.vade-tmp-${process.pid}-${Date.now()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(tmpPath);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`завантаження: HTTP ${res.status}`);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > MAX_DEPLOY_FILE_BYTES) throw new Error('файл завеликий');
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new AgentError(`sha256 не збігається (очікувався ${expected.slice(0, 12)}…, отримано ${actual.slice(0, 12)}…)`, ERR_HASH);
    }
    try {
      await fsp.rename(tmpPath, target);
    } catch {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      await fsp.rename(tmpPath, target);
    }
    log.info(`Deploy файлу завершено: ${target} (${bytes} байт)`);
    return { ok: true, bytes, targetPath: target, message: `Збережено (${bytes} байт)` };
  } catch (e) {
    out.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
}
