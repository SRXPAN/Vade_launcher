import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SITE, SEED_PCS, type AgentStatus, type PcRuntime, type SiteSettings } from '@vade/protocol';
import { SitePublisher } from '../src/main/sitePublisher';

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: { updatedAt: string; pcs: Array<Record<string, unknown>> };
}

let server: http.Server;
let url: string;
let hits: Hit[] = [];
let reply = 200;
let tmp: string;
const publishers: SitePublisher[] = [];

const pcs = SEED_PCS.slice(0, 3);
const online = (occupancy: AgentStatus['occupancy'], state: AgentStatus['state'] = 'idle'): PcRuntime => ({
  pcId: 0,
  link: 'online',
  info: null,
  status: { state, job: null, lastJob: null, nextRunAt: null, pendingPower: null, configRev: null, steamcmdInstalled: true, dryRun: false, occupancy },
  sleeping: false,
  lastSeen: null,
  lastError: null,
  wolSentAt: null,
});

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(over: Partial<SiteSettings> = {}) {
  const settings: SiteSettings = { ...DEFAULT_SITE, enabled: true, url, token: 's3cret', debounceSec: 0.2, heartbeatSec: 60, dailyLimit: 0, ...over };
  const runtimes = new Map<number, PcRuntime>();
  const pub = new SitePublisher({
    getSettings: () => settings,
    getPcs: () => pcs,
    getRuntime: (id) => runtimes.get(id),
    stateFile: path.join(tmp, `counter-${publishers.length}.json`),
    userAgent: 'VadeLauncher/test',
    startupDelayMs: 0,
    minHeartbeatSec: 0.3,
  });
  publishers.push(pub);
  return { pub, settings, runtimes };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-site-'));
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(body) });
      res.statusCode = reply;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/club-status`;
});
beforeEach(() => {
  hits = [];
  reply = 200;
});
afterAll(async () => {
  for (const p of publishers) p.stop();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('site publisher', () => {
  it('sends the public map with the bearer token, only on real changes, merged by debounce', async () => {
    const { pub, runtimes } = make();
    const pushed: number[] = [];
    pub.on('status', (s) => pushed.push(s.sentToday));
    pub.start();
    await waitFor(() => hits.length === 1);
    await waitFor(() => pushed.includes(1)); // the UI gets the updated counter, not the old one
    const first = hits[0];
    expect(first.headers.authorization).toBe('Bearer s3cret');
    expect(first.headers['x-vade-event']).toBe('change');
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.body.pcs).toEqual([
      { id: 1, zone: 'Regular', status: 'offline' },
      { id: 2, zone: 'Regular', status: 'offline' },
      { id: 3, zone: 'Regular', status: 'offline' },
    ]);
    expect(Object.keys(first.body).sort()).toEqual(['pcs', 'updatedAt']);
    expect(JSON.stringify(first.body)).not.toMatch(/10\.70\.4|30:56:0f/);

    // nothing public changed -> nothing sent
    pub.notifyChange();
    await sleep(400);
    expect(hits).toHaveLength(1);

    // three changes within the debounce window -> one request
    runtimes.set(1, online('occupied'));
    pub.notifyChange();
    runtimes.set(2, online('free'));
    pub.notifyChange();
    runtimes.set(3, online('free', 'updating'));
    pub.notifyChange();
    await waitFor(() => hits.length === 2);
    await sleep(400);
    expect(hits).toHaveLength(2);
    expect(hits[1].body.pcs.map((p) => p.status)).toEqual(['occupied', 'free', 'maintenance']);
    expect(pub.status().sentToday).toBe(2);
    pub.stop();
  });

  it('sends a heartbeat when nothing changes', async () => {
    const { pub } = make({ heartbeatSec: 0.4 });
    pub.start();
    await waitFor(() => hits.length >= 1);
    await waitFor(() => hits.some((h) => h.headers['x-vade-event'] === 'heartbeat'), 3000);
    pub.stop();
  });

  it('respects the daily limit and does not count failures or tests', async () => {
    reply = 500;
    const { pub, runtimes } = make({ dailyLimit: 1 });
    pub.start();
    await waitFor(() => pub.status().lastAttempt != null);
    expect(pub.status()).toMatchObject({ sentToday: 0, limitReached: false });
    expect(pub.status().lastAttempt).toMatchObject({ ok: false, status: 500 });

    reply = 200;
    const t = await pub.test(url, 's3cret');
    expect(t).toMatchObject({ ok: true, status: 200 });
    expect(hits.at(-1)!.headers['x-vade-event']).toBe('test');
    expect(pub.status().sentToday).toBe(0);

    runtimes.set(1, online('free'));
    pub.notifyChange();
    await waitFor(() => pub.status().sentToday === 1);
    expect(pub.status().limitReached).toBe(true);

    const before = hits.length;
    runtimes.set(1, online('occupied'));
    pub.notifyChange();
    await sleep(500);
    expect(hits).toHaveLength(before);
    pub.stop();
  });

  it('reports connection errors of the test request', async () => {
    const { pub } = make();
    const r = await pub.test('http://127.0.0.1:1/nothing', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
