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

/**
 * Gateway for everything that touches the system.
 * In dry-run mode every *mutating* operation is only logged, read-only ones still run.
 * This is what makes it safe to run the agent on a developer PC.
 */
export class Sys {
  constructor(
    readonly dryRun: boolean,
    private readonly log: Logger,
  ) {}

  /** Read-only command, always executed. */
  exec(file: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) {
            const c = (err as NodeJS.ErrnoException & { code?: unknown }).code;
            code = typeof c === 'number' ? c : -1;
          }
          resolve({ code, stdout: stdout ?? '', stderr: stderr || (err && code === -1 ? err.message : '') });
        },
      );
    });
  }

  /** Command that changes the system. Skipped (and logged) in dry-run. */
  async mutate(file: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
    if (this.dryRun) {
      this.log.info(`[dry-run] ${path.basename(file)} ${args.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    return this.exec(file, args, timeoutMs);
  }

  /** Runs a PowerShell script passed as -EncodedCommand (no quoting problems). */
  powershell(script: string, opts: { mutating: boolean; timeoutMs?: number }): Promise<ExecResult> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    if (opts.mutating && this.dryRun) {
      this.log.info(`[dry-run] powershell: ${script.split('\n')[0].slice(0, 120)}…`);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
    return this.exec(EXE.powershell, args, opts.timeoutMs ?? 60_000);
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
