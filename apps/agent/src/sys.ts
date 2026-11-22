import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from './logger';
import { EXE } from './win/paths';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RemoveStats {
  removed: number;
  failed: number;
}

export type ConsoleEncoding = 'oem' | 'utf8';

const UTF8_DECODER_FATAL = new TextDecoder('utf-8', { fatal: true });
const CP866_DECODER = new TextDecoder('ibm866');

/**
 * Decodes a console output buffer from Windows CLI tools (reg, powercfg, taskkill, schtasks, net).
 * Russian/Ukrainian Windows console tools output OEM CP866 (IBM866). If a buffer is valid UTF-8
 * (or pure ASCII), UTF-8 is preserved; otherwise CP866 is decoded into clean UTF-8 text.
 */
export function decodeCp866(buf: Buffer | Uint8Array): string {
  return CP866_DECODER.decode(buf);
}

export function decodeConsoleBuffer(
  buf: Buffer | Uint8Array | string | null | undefined,
  encoding: ConsoleEncoding = 'oem',
  oemDecoder: TextDecoder = CP866_DECODER,
): string {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf;
  if (buf.byteLength === 0) return '';
  if (encoding === 'utf8') return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8');
  // Pure ASCII fast path
  let hasHighByte = false;
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] >= 0x80) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8');
  return oemDecoder.decode(buf);
}

const CP_TO_LABEL: Record<number, string> = {
  866: 'ibm866',
  855: 'ibm855',
  852: 'ibm852',
  850: 'ibm850',
  437: 'ibm437',
  1251: 'windows-1251',
  1252: 'windows-1252',
  65001: 'utf-8',
};

/** Parses `chcp` output (e.g. "Текущая кодовая страница: 866" / "Active code page: 866") into a TextDecoder label. */
export function parseChcpLabel(chcpOutput: string): string | null {
  const m = /(\d{3,5})/.exec(chcpOutput);
  if (!m) return null;
  const cp = Number(m[1]);
  return CP_TO_LABEL[cp] ?? null;
}

const PS_UTF8_PREAMBLE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n';

/**
 * Gateway for everything that touches the system.
 * In dry-run mode every *mutating* operation is only logged, read-only ones still run.
 * This is what makes it safe to run the agent on a developer PC.
 */
export class Sys {
  private oemDecoder: TextDecoder = CP866_DECODER;

  constructor(
    readonly dryRun: boolean,
    private readonly log: Logger,
  ) {}

  /** Optionally detects the active Windows OEM codepage via `chcp.com` at agent startup (defaults to CP866). */
  async detectOemCodepage(): Promise<void> {
    try {
      const r = await this.exec(EXE.cmd, ['/d', '/c', 'chcp'], 5_000, 'oem');
      const label = parseChcpLabel(r.stdout);
      if (label) this.oemDecoder = new TextDecoder(label);
    } catch {
      // keep default CP866
    }
  }

  /** Read-only command, always executed. Native Windows tools default to OEM (CP866) decoding. */
  exec(file: string, args: string[], timeoutMs = 120_000, encoding: ConsoleEncoding = 'oem'): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) {
            const c = (err as NodeJS.ErrnoException & { code?: unknown }).code;
            code = typeof c === 'number' ? c : -1;
          }
          const outText = decodeConsoleBuffer(stdout, encoding, this.oemDecoder);
          const errText = decodeConsoleBuffer(stderr, encoding, this.oemDecoder);
          resolve({ code, stdout: outText, stderr: errText || (err && code === -1 ? err.message : '') });
        },
      );
    });
  }

  /** Command that changes the system. Skipped (and logged) in dry-run. */
  async mutate(file: string, args: string[], timeoutMs = 120_000, encoding: ConsoleEncoding = 'oem'): Promise<ExecResult> {
    if (this.dryRun) {
      this.log.info(`[dry-run] ${path.basename(file)} ${args.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    return this.exec(file, args, timeoutMs, encoding);
  }

  /** Runs a PowerShell script passed as -EncodedCommand with explicit UTF-8 output encoding. */
  powershell(script: string, opts: { mutating: boolean; timeoutMs?: number }): Promise<ExecResult> {
    const fullScript = `${PS_UTF8_PREAMBLE}${script}`;
    const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    if (opts.mutating && this.dryRun) {
      this.log.info(`[dry-run] powershell: ${script.split('\n')[0].slice(0, 120)}…`);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return this.exec(EXE.powershell, args, opts.timeoutMs ?? 60_000, 'utf8');
  }

  /**
   * Deletes a file or folder tree. Symlinks and NTFS junctions are removed as links,
   * their targets are NEVER entered. Locked files are counted, not thrown.
   */
  async removeTree(p: string, signal?: AbortSignal): Promise<RemoveStats> {
    const stats: RemoveStats = { removed: 0, failed: 0 };
    let st: Stats;
    try {
      st = await fsp.lstat(p);
    } catch {
      return stats;
    }
    if (this.dryRun) {
      stats.removed = 1;
      return stats;
    }
    await this.removeEntry(p, st, stats, signal);
    return stats;
  }

  /** Deletes everything inside `dir`, keeps `dir` itself. */
  async emptyDir(dir: string, signal?: AbortSignal): Promise<RemoveStats> {
    const stats: RemoveStats = { removed: 0, failed: 0 };
    let st: Stats;
    try {
      st = await fsp.lstat(dir);
    } catch {
      return stats;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return stats;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      stats.failed++;
      return stats;
    }
    if (this.dryRun) {
      stats.removed = names.length;
      return stats;
    }
    await this.removeChildren(dir, names, stats, signal);
    return stats;
  }

  private async removeChildren(dir: string, names: string[], stats: RemoveStats, signal?: AbortSignal): Promise<void> {
    const BATCH = 16;
    for (let i = 0; i < names.length; i += BATCH) {
      if (signal?.aborted) return;
      await Promise.all(
        names.slice(i, i + BATCH).map(async (n) => {
          const child = path.join(dir, n);
          let cs: Stats;
          try {
            cs = await fsp.lstat(child);
          } catch {
            return;
          }
          await this.removeEntry(child, cs, stats, signal);
        }),
      );
    }
  }

  private async removeEntry(p: string, st: Stats, stats: RemoveStats, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (st.isSymbolicLink()) {
      // Junction or symlink: delete only the link.
      try {
        await fsp.unlink(p);
        stats.removed++;
      } catch {
        try {
          await fsp.rmdir(p);
          stats.removed++;
        } catch {
          stats.failed++;
        }
      }
      return;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = await fsp.readdir(p);
      } catch {
        stats.failed++;
        return;
      }
      await this.removeChildren(p, names, stats, signal);
      try {
        await fsp.rmdir(p);
      } catch {
        // not empty because something inside is locked: already counted
      }
      return;
    }
    try {
      await fsp.unlink(p);
      stats.removed++;
    } catch {
      try {
        await fsp.chmod(p, 0o666); // clear the read-only attribute
        await fsp.unlink(p);
        stats.removed++;
      } catch {
        stats.failed++;
      }
    }
  }
}
