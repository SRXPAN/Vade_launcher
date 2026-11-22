import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ERR_HASH, PROTOCOL_VERSION } from '@vade/protocol';
import { downloadDeployFile, execDeployCommand, validateDeployTargetPath } from '../src/jobs/deploy';
import { resolveSafeGamePaths, uninstallSteamGame } from '../src/jobs/games';
import { Logger } from '../src/logger';
import { installedApps, listInstalledGames } from '../src/steam/libraries';
import { AgentStore } from '../src/store';
import { Sys } from '../src/sys';
import { collectAgentDiagnostics, isProtectedProcessName, killProcessSafe } from '../src/win/diagnostics';

let tmp: string;
let log: Logger;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-agent-mod-'));
  log = new Logger(path.join(tmp, 'logs'), false);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Stage 1: Steam games inventory & safe uninstall', () => {
  it('parses appmanifest name, installdir, and SizeOnDisk across Steam libraries', () => {
    const steam = path.join(tmp, 'Steam');
    const secondLib = path.join(tmp, 'D_SteamLibrary');
    fs.mkdirSync(path.join(steam, 'steamapps', 'common', 'Counter-Strike Global Offensive'), { recursive: true });
    fs.mkdirSync(path.join(secondLib, 'steamapps', 'common', 'Deadlock'), { recursive: true });
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "0" { "path" "${steam.replace(/\\/g, '\\\\')}" } "1" { "path" "${secondLib.replace(/\\/g, '\\\\')}" } }`,
    );
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'appmanifest_730.acf'),
      '"AppState" { "appid" "730" "name" "Counter-Strike 2" "installdir" "Counter-Strike Global Offensive" "SizeOnDisk" "38123456789" }',
    );
    fs.writeFileSync(
      path.join(secondLib, 'steamapps', 'appmanifest_1422450.acf'),
      '"AppState" { "appid" "1422450" "name" "Deadlock" "installdir" "Deadlock" "SizeOnDisk" "25000000000" }',
    );

    const parsed = installedApps(secondLib);
    expect(parsed).toEqual([
      { appId: 1422450, name: 'Deadlock', installDir: 'Deadlock', sizeOnDiskBytes: 25000000000 },
    ]);

    const all = listInstalledGames(steam);
    expect(all).toHaveLength(2);
    expect(all.find((g) => g.appId === 730)?.sizeOnDiskBytes).toBe(38123456789);
    expect(all.find((g) => g.appId === 1422450)?.libraryPath).toBe(secondLib);
  });

  it('rejects path-traversal installdir values', () => {
    expect(() => resolveSafeGamePaths('C:\\Steam', 730, '..\\..\\Windows')).toThrow(/Небезпечна/);
    expect(() => resolveSafeGamePaths('C:\\Steam', 730, 'a/b')).toThrow(/Небезпечна/);
    expect(() => resolveSafeGamePaths('C:\\Steam', 730, '.')).toThrow(/Небезпечна/);
    expect(() => resolveSafeGamePaths('C:\\Steam', 730, 'C:\\Evil')).toThrow(/Небезпечна/);
    const safe = resolveSafeGamePaths('C:\\Steam', 730, 'Counter-Strike Global Offensive');
    expect(safe.gameDir).toBe('C:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive');
    expect(safe.manifestPath).toBe('C:\\Steam\\steamapps\\appmanifest_730.acf');
  });

  it('uninstalls only allowed library games and refuses unknown libraries or traversal', async () => {
    const steam = path.join(tmp, 'Steam');
    const commonGame = path.join(steam, 'steamapps', 'common', 'AlienGame');
    fs.mkdirSync(commonGame, { recursive: true });
    fs.writeFileSync(path.join(commonGame, 'game.bin'), '12345');
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'appmanifest_999.acf'),
      '"AppState" { "appid" "999" "name" "Alien Game" "installdir" "AlienGame" "SizeOnDisk" "5" }',
    );
    fs.writeFileSync(
      path.join(steam, 'steamapps', 'appmanifest_666.acf'),
      '"AppState" { "appid" "666" "name" "Evil" "installdir" "..\\\\..\\\\Windows" "SizeOnDisk" "1" }',
    );

    const sys = new Sys(false, log);
    const noKill = async () => undefined;
    await expect(
      uninstallSteamGame({ sys, log, steamPath: steam, killSteam: noKill }, { appId: 999, libraryPath: 'C:\\NotALibrary' }),
    ).rejects.toThrow(/Бібліотеку Steam/);
    await expect(
      uninstallSteamGame({ sys, log, steamPath: steam, killSteam: noKill }, { appId: 666, libraryPath: steam }),
    ).rejects.toThrow(/Небезпечна/);

    const realRes = await uninstallSteamGame({ sys, log, steamPath: steam, killSteam: noKill }, { appId: 999, libraryPath: steam });
    expect(realRes.ok).toBe(true);
    expect(fs.existsSync(commonGame)).toBe(false);
    expect(fs.existsSync(path.join(steam, 'steamapps', 'appmanifest_999.acf'))).toBe(false);
  });
});

describe('Stage 2: Protected process guard', () => {
  it('blocks critical Windows and VadeAgent processes from termination', async () => {
    for (const name of ['csrss.exe', 'lsass.exe', 'wininit.exe', 'svchost.exe', 'VadeAgent.exe', 'VadeAgentService.exe', 'vadeagent']) {
      expect(isProtectedProcessName(name)).toBe(true);
    }
    expect(isProtectedProcessName('notepad.exe')).toBe(false);
    expect(isProtectedProcessName('chrome.exe')).toBe(false);

    const sys = new Sys(true, log);
    await expect(killProcessSafe(sys, log, 0)).rejects.toThrow(/PID/);
    await expect(killProcessSafe(sys, log, 4)).rejects.toThrow(/PID/);
    await expect(killProcessSafe(sys, log, process.pid)).rejects.toThrow(/VadeAgent/);
  });
});

describe('Stage 3: Broadcast exec & verified file deploy', () => {
  it('validates destination file path strictly', () => {
    expect(() => validateDeployTargetPath('relative\\path.txt')).toThrow(/абсолютний/);
    expect(() => validateDeployTargetPath('C:\\Games\\..\\Windows\\evil.dll')).toThrow(/\.\./);
    expect(() => validateDeployTargetPath('C:\\')).toThrow(/Корінь/);
    expect(validateDeployTargetPath('C:\\Games\\cfg\\autoexec.cfg')).toMatch(/autoexec\.cfg$/i);
  });

  it('downloads, verifies sha256, creates parent dirs, and rejects tampered sha256', async () => {
    const payload = Buffer.from('vade-deploy-payload-utf8-тест-і-ї-є', 'utf8');
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const wrongSha = '0'.repeat(64);

    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
      res.end(payload);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/file.bin`;
    const sys = new Sys(false, log);

    try {
      const targetOk = path.join(tmp, 'nested', 'dir', 'settings.cfg');
      const res = await downloadDeployFile(sys, log, { url, sha256, targetPath: targetOk });
      expect(res.ok).toBe(true);
      expect(res.bytes).toBe(payload.length);
      expect(fs.readFileSync(targetOk).equals(payload)).toBe(true);

      const targetBad = path.join(tmp, 'nested', 'bad.cfg');
      await expect(downloadDeployFile(sys, log, { url, sha256: wrongSha, targetPath: targetBad })).rejects.toMatchObject({
        code: ERR_HASH,
      });
      expect(fs.existsSync(targetBad)).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('executes CMD deploy command and returns exit code + stdout', async () => {
    const sys = new Sys(false, log);
    const r = await execDeployCommand(sys, log, { shell: 'cmd', script: 'echo hello-vade-deploy', timeoutSec: 15 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-vade-deploy');
    expect(r.timedOut).toBe(false);
  });
});

describe('Stage 6: Agent diagnostics bundle redaction', () => {
  it('redacts clubKey from both config and log strings', () => {
    const dataDir = path.join(tmp, 'agent-data');
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    const secretKey = 'super-secret-club-key-1234567890';
    fs.writeFileSync(path.join(dataDir, 'agent.json'), JSON.stringify({ clubKey: secretKey, port: 7420, allowFrom: ['10.70.4.10'] }));
    fs.writeFileSync(path.join(dataDir, 'logs', 'agent.log'), `Started with key=${secretKey}\nNormal line\n`);
    fs.writeFileSync(path.join(dataDir, 'steamcmd-last.txt'), `Steam output ok key=${secretKey}`);

    const store = new AgentStore(dataDir);
    const bundle = collectAgentDiagnostics({
      dataDir,
      store,
      log,
      info: { protocol: PROTOCOL_VERSION, version: '0.4.0', hostname: 'PC-01', nics: [], os: 'Windows', startedAt: new Date().toISOString() },
      status: {
        state: 'idle',
        job: null,
        lastJob: null,
        nextRunAt: null,
        pendingPower: null,
        configRev: null,
        steamcmdInstalled: true,
        dryRun: true,
      },
    });

    const jsonStr = JSON.stringify(bundle);
    expect(jsonStr).not.toContain(secretKey);
    expect((bundle.agentConfig.fileConfig as { clubKey: string }).clubKey).toBe('***REDACTED***');
    expect(bundle.agentLog).toContain('***REDACTED***');
    expect(bundle.steamcmdLast).toContain('***REDACTED***');
  });
});
