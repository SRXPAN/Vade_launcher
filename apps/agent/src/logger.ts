import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel, LogLine } from '@vade/protocol';

const MAX_FILE_BYTES = 2_000_000;
const RING_SIZE = 1000;

/**
 * Writes agent.log (rotated at 2 MB, one old copy kept), keeps the last lines in
 * memory for `log.history`, and emits every line so the server can stream it.
 */
export class Logger extends EventEmitter {
  private ring: LogLine[] = [];
  private readonly file: string;
  private writes = 0;

  constructor(
    dir: string,
    private readonly echo: boolean,
  ) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'agent.log');
  }

  log(level: LogLevel, msg: string, jobId?: string): void {
    const line: LogLine = { ts: new Date().toISOString(), level, msg };
    if (jobId) line.jobId = jobId;
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    this.writeFile(line);
    if (this.echo) {
      const out = level === 'error' ? console.error : console.log;
      out(`${level.toUpperCase().padEnd(5)} ${msg}`);
    }
    this.emit('line', line);
  }

  info(msg: string, jobId?: string): void {
    this.log('info', msg, jobId);
  }
  warn(msg: string, jobId?: string): void {
    this.log('warn', msg, jobId);
  }
  error(msg: string, jobId?: string): void {
    this.log('error', msg, jobId);
  }

  history(limit: number): LogLine[] {
    return this.ring.slice(-Math.max(1, Math.min(limit, RING_SIZE)));
  }

  private writeFile(line: LogLine): void {
    try {
      if (this.writes++ % 100 === 0) {
        const st = fs.statSync(this.file, { throwIfNoEntry: false });
        if (st && st.size > MAX_FILE_BYTES) {
          fs.rmSync(`${this.file}.1`, { force: true });
          fs.renameSync(this.file, `${this.file}.1`);
        }
      }
      const d = new Date(line.ts);
      const ts = `${d.toLocaleDateString('uk-UA')} ${d.toLocaleTimeString('uk-UA')}`;
      fs.appendFileSync(this.file, `[${ts}] ${line.level.toUpperCase().padEnd(5)} ${line.msg}\r\n`);
    } catch {
      // logging must never crash the agent
    }
  }
}
