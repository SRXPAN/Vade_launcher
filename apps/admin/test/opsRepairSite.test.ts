import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSitePayload,
  DEFAULT_SITE,
  publicPcStatus,
  sitePayloadSignature,
  type AgentStatus,
  type PcRecord,
  type PcRuntime,
  type SitePayload,
  type SiteSettings,
} from '@vade/protocol';
import { SitePublisher } from '../src/main/sitePublisher';

const makeRuntime = (
  pcId: number,
  opts: { link?: PcRuntime['link']; occupancy?: AgentStatus['occupancy']; sleeping?: boolean } = {},
): PcRuntime => {
  const link = opts.link ?? 'online';
  return {
    pcId,
    link,
    info: null,
    status:
      link === 'online'
        ? {
            state: 'idle',
            job: null,
            lastJob: null,
            nextRunAt: null,
            pendingPower: null,
            configRev: null,
            steamcmdInstalled: true,
            dryRun: false,
            occupancy: opts.occupancy ?? 'free',
          }
        : null,
    sleeping: opts.sleeping ?? false,
    lastSeen: null,
    lastError: null,
    wolSentAt: null,
  };
};

const makePc = (id: number, serviceNote?: PcRecord['serviceNote']): PcRecord => ({
  id,
  ip: `10.70.4.${100 + id}`,
  mac: `30:56:0f:3e:00:${String(id).padStart(2, '0')}`,
  zone: 'Regular',
  ...(serviceNote ? { serviceNote } : {}),
});

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('Repair status (Out of Service) + Site integration', () => {
  let tmpDir: string;
  const publishers: SitePublisher[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-repair-site-'));
  });

  afterEach(() => {
    for (const p of publishers.splice(0)) p.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forces publicPcStatus to "maintenance" when serviceNote.outOfService is true regardless of runtime state', () => {
    const repairPc = makePc(1, { outOfService: true, text: 'Broken GPU', updatedAt: Date.now(), author: 'Alex' });

    expect(publicPcStatus(makeRuntime(1, { link: 'online', occupancy: 'free' }), repairPc)).toBe('maintenance');
    expect(publicPcStatus(makeRuntime(1, { link: 'online', occupancy: 'occupied' }), repairPc)).toBe('maintenance');
    expect(publicPcStatus(makeRuntime(1, { link: 'offline', sleeping: true }), repairPc)).toBe('maintenance');
    expect(publicPcStatus(makeRuntime(1, { link: 'offline', sleeping: false }), repairPc)).toBe('maintenance');
    expect(publicPcStatus(undefined, repairPc)).toBe('maintenance');
  });

  it('keeps normal free/occupied/offline statuses when serviceNote.outOfService is false', () => {
    const notePc = makePc(2, { outOfService: false, text: 'Sticky spacebar', updatedAt: Date.now(), author: 'Kate' });

    expect(publicPcStatus(makeRuntime(2, { link: 'online', occupancy: 'free' }), notePc)).toBe('free');
    expect(publicPcStatus(makeRuntime(2, { link: 'online', occupancy: 'occupied' }), notePc)).toBe('occupied');
    expect(publicPcStatus(makeRuntime(2, { link: 'offline', sleeping: true }), notePc)).toBe('offline');
    expect(publicPcStatus(makeRuntime(2, { link: 'offline', sleeping: false }), notePc)).toBe('offline');
    expect(publicPcStatus(undefined, notePc)).toBe('offline');
  });

  it('updates sitePayloadSignature when outOfService flips false -> true without leaking note text', () => {
    const rtMap = new Map<number, PcRuntime>([[1, makeRuntime(1, { link: 'online', occupancy: 'free' })]]);
    const pcNoteOnly = makePc(1, { outOfService: false, text: 'Sticky spacebar', updatedAt: 1000, author: 'Kate' });
    const pcTextEdited = makePc(1, { outOfService: false, text: 'Sticky spacebar + noisy fan', updatedAt: 2000, author: 'Kate' });
    const pcRepair = makePc(1, { outOfService: true, text: 'Broken GPU', updatedAt: 3000, author: 'Alex' });

    const p1 = buildSitePayload([pcNoteOnly], (id) => rtMap.get(id), new Date(1000));
    const p2 = buildSitePayload([pcTextEdited], (id) => rtMap.get(id), new Date(2000));
    const p3 = buildSitePayload([pcRepair], (id) => rtMap.get(id), new Date(3000));

    expect(p1.pcs).toEqual([{ id: 1, zone: 'Regular', status: 'free' }]);
    expect(sitePayloadSignature(p1)).toBe(sitePayloadSignature(p2));
    expect(p3.pcs).toEqual([{ id: 1, zone: 'Regular', status: 'maintenance' }]);
    expect(sitePayloadSignature(p3)).not.toBe(sitePayloadSignature(p1));
    expect(JSON.stringify(p3)).not.toContain('Broken GPU');
    expect(JSON.stringify(p3)).not.toContain('Alex');
  });

  it('publishes "maintenance" via mocked fetchImpl and sends an update when outOfService toggles false -> true', async () => {
    const pcs: PcRecord[] = [
      makePc(1, { outOfService: false, text: 'Sticky spacebar', updatedAt: Date.now() }),
      makePc(2, { outOfService: true, text: 'Broken GPU', updatedAt: Date.now() }),
      makePc(3, { outOfService: true, text: 'Broken GPU', updatedAt: Date.now() }),
      makePc(4, { outOfService: true, text: 'Broken GPU', updatedAt: Date.now() }),
      makePc(5, { outOfService: false, text: 'Sticky spacebar', updatedAt: Date.now() }),
      makePc(6, { outOfService: false, text: 'Sticky spacebar', updatedAt: Date.now() }),
    ];

    const runtimes = new Map<number, PcRuntime>([
      [1, makeRuntime(1, { link: 'online', occupancy: 'free' })],
      [2, makeRuntime(2, { link: 'online', occupancy: 'free' })],
      [3, makeRuntime(3, { link: 'online', occupancy: 'occupied' })],
      [4, makeRuntime(4, { link: 'offline', sleeping: true })],
      [5, makeRuntime(5, { link: 'online', occupancy: 'occupied' })],
      [6, makeRuntime(6, { link: 'offline', sleeping: false })],
    ]);

    const posts: Array<{ url: string; method: string; headers: Record<string, string>; payload: SitePayload }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      posts.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        payload: JSON.parse(String(init?.body ?? '{}')) as SitePayload,
      });
      return new Response(null, { status: 200, statusText: 'OK' });
    });

    const settings: SiteSettings = {
      ...DEFAULT_SITE,
      enabled: true,
      url: 'https://club.example.com/api/club-status',
      token: 'test-token',
      debounceSec: 0,
      heartbeatSec: 60,
      dailyLimit: 0,
    };

    const pub = new SitePublisher({
      getSettings: () => settings,
      getPcs: () => pcs,
      getRuntime: (id) => runtimes.get(id),
      stateFile: path.join(tmpDir, 'site-counter.json'),
      userAgent: 'VadeLauncher/test',
      fetchImpl: fetchMock,
      startupDelayMs: 0,
      minHeartbeatSec: 60,
    });
    publishers.push(pub);

    pub.start();
    await waitFor(() => posts.length === 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posts[0].url).toBe('https://club.example.com/api/club-status');
    expect(posts[0].method).toBe('POST');
    expect(posts[0].headers.Authorization).toBe('Bearer test-token');
    expect(posts[0].headers['X-Vade-Event']).toBe('change');
    expect(posts[0].payload.pcs).toEqual([
      { id: 1, zone: 'Regular', status: 'free' },
      { id: 2, zone: 'Regular', status: 'maintenance' },
      { id: 3, zone: 'Regular', status: 'maintenance' },
      { id: 4, zone: 'Regular', status: 'maintenance' },
      { id: 5, zone: 'Regular', status: 'occupied' },
      { id: 6, zone: 'Regular', status: 'offline' },
    ]);

    // Changing only desk note text without toggling outOfService should NOT trigger a POST
    pcs[0] = makePc(1, { outOfService: false, text: 'Changed desk note only', updatedAt: Date.now() });
    pub.notifyChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(posts).toHaveLength(1);

    // Flipping PC #1 outOfService from false -> true changes signature and triggers a POST
    const sigBefore = sitePayloadSignature(pub.payload());
    pcs[0] = makePc(1, { outOfService: true, text: 'Broken GPU', updatedAt: Date.now() });
    const sigAfter = sitePayloadSignature(pub.payload());
    expect(sigAfter).not.toBe(sigBefore);

    pub.notifyChange();
    await waitFor(() => posts.length === 2);

    expect(posts[1].payload.pcs[0]).toEqual({ id: 1, zone: 'Regular', status: 'maintenance' });
    expect(pub.status().sentToday).toBe(2);
  });
});
