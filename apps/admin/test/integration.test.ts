/**
 * End-to-end over a real WebSocket on 127.0.0.1:
 * admin AgentLink  <->  agent AgentServer + Agent (DRY-RUN: nothing on this PC is changed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { buildAgentConfig, defaultSettings, type AgentStatus, type LinkState, type LogLine } from '@vade/protocol';
import { newClubKey } from '@vade/protocol/auth';
import { Agent } from '../../agent/src/agent';
import { Logger } from '../../agent/src/logger';
import { AgentServer } from '../../agent/src/server';
import { AgentStore } from '../../agent/src/store';
import { Sys } from '../../agent/src/sys';
import { AgentLink } from '../src/main/agentLink';
import { magicPacket } from '../src/main/wol';

const key = newClubKey();
let tmp: string;
let agent: Agent;
let server: AgentServer;
let port: number;

function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const v = fn();
      if (v) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error('timeout'));
      }
    }, 25);
  });
}

function linkTo(clubKey: string, p = port) {
  const link = new AgentLink({ host: '127.0.0.1', port: p, clubKey, clientName: 'test' });
  const states: LinkState[] = [];
  link.on('link', (s) => states.push(s));
  link.start();
  return { link, states };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-e2e-'));
  // A fake Steam install so the job walks every step.
  const steam = path.join(tmp, 'Steam');
  fs.mkdirSync(path.join(steam, 'steamapps', 'workshop', 'content', '730'), { recursive: true });
  fs.writeFileSync(path.join(steam, 'steam.exe'), '');
  fs.writeFileSync(path.join(steam, 'steamapps', 'appmanifest_730.acf'), '"AppState" { "appid" "730" "name" "Counter-Strike 2" }');

  const dataDir = path.join(tmp, 'agent-data');
  const store = new AgentStore(dataDir);
  const log = new Logger(path.join(dataDir, 'logs'), false);
  const sys = new Sys(true, log);
  agent = new Agent({ sys, log, store, dataDir, presenceMode: 'off' });
  server = new AgentServer(agent, { port: 0, bind: '127.0.0.1', clubKey: key, allowFrom: [] });
  await server.start();
  await agent.init();
  port = server.port;
});

afterAll(async () => {
  await agent.shutdown();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('admin <-> agent', () => {
  it('authenticates with the club key and receives hello', async () => {
    const { link } = linkTo(key);
    let hello: AgentStatus | null = null;
    link.on('hello', (_info, status) => (hello = status));
    await waitFor(() => link.state === 'online');
    await waitFor(() => hello);
    expect(hello!.dryRun).toBe(true);
    const status = await link.request('status.get', {});
    expect(status.state).toBe('idle');
    link.stop();
  });

  it('rejects a wrong club key', async () => {
    const { link, states } = linkTo('wrong-key-wrong-key');
    await waitFor(() => states.includes('auth-failed'));
    expect(link.lastError).toMatch(/ключ/);
    link.stop();
  });

  it('does not trust a fake agent that cannot prove the key', async () => {
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => fake.once('listening', r));
    fake.on('connection', (ws) => {
      ws.send(JSON.stringify({ t: 'challenge', nonce: 'n', protocol: 1 }));
      ws.on('message', () => ws.send(JSON.stringify({ t: 'hello', proof: 'forged', info: {}, status: {} })));
    });
    const { link, states } = linkTo(key, (fake.address() as { port: number }).port);
    await waitFor(() => states.includes('auth-failed'));
    expect(states).not.toContain('online');
    link.stop();
    await new Promise((r) => fake.close(r));
  });

  it('applies config, runs a full test job and streams logs', async () => {
    const { link } = linkTo(key);
    const logs: LogLine[] = [];
    let last: AgentStatus | null = null;
    link.on('log', (l) => logs.push(l));
    link.on('status', (s) => (last = s));
    await waitFor(() => link.state === 'online');

    const settings = defaultSettings(key);
    settings.maintenance.steamPath = path.join(tmp, 'Steam');
    settings.maintenance.steamcmdDir = path.join(tmp, 'steamcmd');
    const cfg = buildAgentConfig(settings, { id: 5, ip: '127.0.0.1', mac: '30:56:0f:3e:94:6a', zone: 'Regular' });
    const applied = await link.request('config.apply', cfg);
    expect(applied.changed).toBe(true);
    expect((await link.request('config.apply', cfg)).changed).toBe(false);

    const { jobId } = await link.request('job.start', { mode: 'test' });
    await expect(link.request('job.start', { mode: 'test' })).rejects.toThrow(/вже виконується/);
    const done = await waitFor(() => (last?.lastJob?.id === jobId && last.state === 'idle' ? last.lastJob : null), 60_000);

    expect(done.result).toBe('ok');
    expect(done.steps.map((s) => s.id)).toEqual(['closeSteam', 'cleanTemp', 'steamLogins', 'steamCache', 'workshop', 'update']);
    expect(done.steps.find((s) => s.id === 'update')?.status).toBe('skipped'); // no SteamCMD in dry-run
    expect(done.apps).toEqual([]); // SteamCMD missing -> nothing queued
    expect(last!.pendingPower).toBeNull(); // test run never powers off
    expect(logs.some((l) => /СТАРТ/.test(l.msg))).toBe(true);
    expect(logs.some((l) => /RESULT: OK/.test(l.msg))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'Steam', 'steamapps', 'workshop', 'content', '730'))).toBe(true); // dry-run kept it

    const history = await link.request('log.history', { limit: 500 });
    expect(history.some((l) => l.jobId === jobId)).toBe(true);
    link.stop();
  });

  it('seals the Steam password for the agent', async () => {
    const { link } = linkTo(key);
    await waitFor(() => link.state === 'online');
    const r = await link.request('steam.login', { user: 'club_user', password: link.sealSecret('secret') });
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/dry-run/);
    link.stop();
  });

  it('refuses maintenance on an occupied PC unless forced', async () => {
    const { link } = linkTo(key);
    let last: AgentStatus | null = null;
    link.on('status', (s) => (last = s));
    await waitFor(() => link.state === 'online');
    // The player-session reporter says: mouse moved 1 s ago.
    const presenceDir = path.join(tmp, 'agent-data', 'presence');
    fs.writeFileSync(
      path.join(presenceDir, 'session-1.json'),
      JSON.stringify({ v: 1, ts: Date.now(), session: 1, user: 'Player', idleMs: 1000, locked: false, fgProc: 'chrome.exe', fgPath: '', fgTitle: 'YouTube', procs: ['explorer.exe'] }),
    );
    await agent.detector.tick();
    const st = await link.request('status.get', {});
    expect(st).toMatchObject({ occupancy: 'occupied', occupancyReason: 'active_input' });
    expect(st.presence).toMatchObject({ user: 'Player', foreground: 'chrome.exe' });

    const refused = await link.request('job.start', { mode: 'test' }).catch((e: Error & { code?: string }) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error & { code?: string }).code).toBe('occupied');

    const { jobId } = await link.request('job.start', { mode: 'test', force: true });
    await waitFor(() => (last?.lastJob?.id === jobId && last.state === 'idle' ? true : null), 60_000);
    fs.rmSync(path.join(presenceDir, 'session-1.json'), { force: true });
    link.stop();
  });

  it('schedules and cancels a power action (dry-run)', async () => {
    const { link } = linkTo(key);
    await waitFor(() => link.state === 'online');
    const p = await link.request('power', { action: 'hibernate', delaySec: 60 });
    expect(p.action).toBe('hibernate');
    expect((await link.request('power.cancel', {})).cancelled).toBe(true);
    link.stop();
  });
});

describe('wake-on-lan', () => {
  it('builds a valid magic packet', () => {
    const pkt = magicPacket('30:56:0f:3e:93:88');
    expect(pkt.length).toBe(102);
    expect(pkt.subarray(0, 6).toString('hex')).toBe('ffffffffffff');
    expect(pkt.subarray(6, 12).toString('hex')).toBe('30560f3e9388');
    expect(pkt.subarray(96, 102).toString('hex')).toBe('30560f3e9388');
  });
});
