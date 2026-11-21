import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../logger';
import type { Sys } from '../sys';
import { EXE } from './paths';

/**
 * Keeps Windows from sleeping while a job runs: a hidden helper calls
 * SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) every 20 s.
 * The state is released by the OS when the helper exits; the helper exits on stop()
 * or by itself when the agent process disappears (no orphan keeps the PC awake).
 */
export class AwakeGuard {
  private child: ChildProcess | null = null;

  constructor(
    private readonly sys: Sys,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.child) return;
    if (this.sys.dryRun) {
      this.log.info('[dry-run] SetThreadExecutionState не викликається');
      return;
    }
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace VadeAgent -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$parent = ${process.pid}
while (Get-Process -Id $parent -ErrorAction SilentlyContinue) {
  [void][VadeAgent.Awake]::SetThreadExecutionState([uint32]2147483649)
  Start-Sleep -Seconds 20
}
[void][VadeAgent.Awake]::SetThreadExecutionState([uint32]2147483648)
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      this.child = spawn(EXE.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: 'ignore',
      });
      this.child.on('error', (e) => this.log.warn(`Awake helper: ${e.message}`));
      this.child.on('exit', () => {
        this.child = null;
      });
    } catch (e) {
      this.log.warn(`Не вдалося запустити awake helper: ${String(e)}`);
    }
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}
