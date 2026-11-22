import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Logger } from '../src/logger';
import { Sys, type ExecResult } from '../src/sys';
import { applyPowerPolicy } from '../src/win/power';

/** Records every mutating command instead of running it. */
class RecordingSys extends Sys {
  readonly calls: Array<{ exe: string; args: string[] }> = [];
  constructor(
    log: Logger,
    private readonly fail: (exe: string) => boolean = () => false,
  ) {
    super(false, log);
  }
  override async mutate(file: string, args: string[]): Promise<ExecResult> {
    const exe = path.basename(file).toLowerCase();
    this.calls.push({ exe, args });
    return this.fail(exe) ? { code: 1, stdout: '', stderr: 'Access is denied.' } : { code: 0, stdout: '', stderr: '' };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-power-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\0e796bdb-100d-47d6-a2d5-f7d2daa51f51';

describe('applyPowerPolicy (installer + every service start)', () => {
  it('turns off "password after wake" in the power scheme and in the HKLM policy', async () => {
    const sys = new RecordingSys(new Logger(path.join(tmp, 'a'), false));
    await applyPowerPolicy(sys, new Logger(path.join(tmp, 'a'), false));
    const reg = sys.calls.filter((c) => c.exe === 'reg.exe').map((c) => c.args);
    expect(reg).toEqual([
      ['add', KEY, '/v', 'ACSettingIndex', '/t', 'REG_DWORD', '/d', '0', '/f'],
      ['add', KEY, '/v', 'DCSettingIndex', '/t', 'REG_DWORD', '/d', '0', '/f'],
    ]);
    const powercfg = sys.calls.filter((c) => c.exe === 'powercfg.exe').map((c) => c.args.join(' '));
    expect(powercfg).toContain('/setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0');
    expect(powercfg).toContain('/setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0');
  });

  it('a failed reg.exe is logged as a warning and does not stop the agent start', async () => {
    const logDir = path.join(tmp, 'b');
    const log = new Logger(logDir, false);
    const sys = new RecordingSys(log, (exe) => exe === 'reg.exe');
    await expect(applyPowerPolicy(sys, log)).resolves.toBeUndefined();
    expect(sys.calls.filter((c) => c.exe === 'reg.exe')).toHaveLength(2);
    const text = fs.readFileSync(path.join(logDir, 'agent.log'), 'utf8');
    expect(text).toMatch(/WARN.*reg add .*0e796bdb-100d-47d6-a2d5-f7d2daa51f51 \/v ACSettingIndex.*код 1/);
    expect(text).toMatch(/WARN.*DCSettingIndex.*код 1/);
  });

  it('dry-run only logs the commands', async () => {
    const logDir = path.join(tmp, 'c');
    const log = new Logger(logDir, false);
    await applyPowerPolicy(new Sys(true, log), log);
    const text = fs.readFileSync(path.join(logDir, 'agent.log'), 'utf8');
    expect(text).toContain(`[dry-run] reg.exe add ${KEY} /v ACSettingIndex /t REG_DWORD /d 0 /f`);
    expect(text).toContain(`[dry-run] reg.exe add ${KEY} /v DCSettingIndex /t REG_DWORD /d 0 /f`);
  });
});
