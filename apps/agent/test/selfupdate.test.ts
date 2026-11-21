import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERR_HASH } from '@vade/protocol';
import { downloadVerified, installedServicePaths, launchHelperScript, sha256File, updateHelperScript } from '../src/update/selfUpdate';
import { disksChanged, readDisk } from '../src/win/disks';

let tmp: string;
let server: http.Server;
let base: string;
const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300_000, 7)]);
const exeSha = createHash('sha256').update(exe).digest('hex');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-update-'));
  server = http.createServer((req, res) => {
    if (req.url === '/agent.exe') return res.end(exe);
    if (req.url === '/not-exe') return res.end(Buffer.alloc(1000, 1));
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('self-update download and sha256 check', () => {
  it('keeps the file when the hash matches', async () => {
    const dest = path.join(tmp, 'VadeAgent.new.exe');
    const r = await downloadVerified(`${base}/agent.exe`, dest, exeSha.toUpperCase());
    expect(r.bytes).toBe(exe.length);
    expect(await sha256File(dest)).toBe(exeSha);
  });

  it('wrong hash: error with code hash_mismatch and the file is deleted', async () => {
    const dest = path.join(tmp, 'bad.new.exe');
    const err = await downloadVerified(`${base}/agent.exe`, dest, 'a'.repeat(64)).catch((e: Error & { code?: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe(ERR_HASH);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('rejects non-executables, HTTP errors and malformed hashes', async () => {
    const notExe = Buffer.alloc(1000, 1);
    const sha = createHash('sha256').update(notExe).digest('hex');
    await expect(downloadVerified(`${base}/not-exe`, path.join(tmp, 'x.exe'), sha)).rejects.toThrow(/не є \.exe/);
    await expect(downloadVerified(`${base}/missing`, path.join(tmp, 'y.exe'), exeSha)).rejects.toThrow(/HTTP 404/);
    await expect(downloadVerified(`${base}/agent.exe`, path.join(tmp, 'z.exe'), 'abc')).rejects.toThrow(/sha256/);
    expect(fs.existsSync(path.join(tmp, 'x.exe')) || fs.existsSync(path.join(tmp, 'y.exe'))).toBe(false);
  });

  it('only the installed service can replace itself', () => {
    expect(installedServicePaths('C:\\Program Files\\nodejs\\node.exe')).toBeNull();
    const dir = path.join(tmp, 'VadeAgent');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'VadeAgentService.exe'), '');
    expect(installedServicePaths(path.join(dir, 'VadeAgent.exe'))).toMatchObject({ newExe: path.join(dir, 'VadeAgent.new.exe'), oldExe: path.join(dir, 'VadeAgent.old.exe') });
  });

  it('helper scripts are valid PowerShell and can be nested', () => {
    const helper = updateHelperScript({ installDir: "C:\\Program Files\\VadeAgent", dataDir: "C:\\ProgramData\\VadeAgent", fromVersion: '0.2.0', toVersion: '0.3.0' });
    expect(helper).not.toMatch(/^'@/m);
    for (const [name, text] of Object.entries({ helper, launcher: launchHelperScript(helper) })) {
      const f = path.join(tmp, `${name}.ps1`);
      fs.writeFileSync(f, `\uFEFF${text}`, 'utf8');
      const n = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e.Count`],
        { encoding: 'utf8' },
      ).trim();
      expect(`${name}: ${n}`).toBe(`${name}: 0`);
    }
  });
});

describe('disks', () => {
  it('reads free space of C:', async () => {
    const c = await readDisk('C:');
    expect(c).not.toBeNull();
    expect(c!.totalBytes).toBeGreaterThan(10 * 1024 ** 3);
    expect(c!.freeBytes).toBeGreaterThan(0);
    expect(c!.freeBytes).toBeLessThanOrEqual(c!.totalBytes);
    expect(await readDisk('Q:')).toBeNull();
  });

  it('reports only meaningful changes', () => {
    const GB = 1024 ** 3;
    const a = [{ drive: 'C:', freeBytes: 40 * GB, totalBytes: 500 * GB }];
    expect(disksChanged(a, [{ ...a[0], freeBytes: 40 * GB + 100 * 1024 ** 2 }])).toBe(false);
    expect(disksChanged(a, [{ ...a[0], freeBytes: 39 * GB }])).toBe(true);
    expect(disksChanged(a, [...a, { drive: 'D:', freeBytes: GB, totalBytes: 2 * GB }])).toBe(true);
  });
});
