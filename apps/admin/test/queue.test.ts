import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERR_OCCUPIED, type AgentStatus, type JobMode, type JobState, type PcRecord, type PcRuntime } from '@vade/protocol';
import { AgentUpdater, UpdateServer, type UpdaterHost } from '../src/main/agentUpdater';
import { MaintenanceQueue, type QueueHost } from '../src/main/maintenanceQueue';
import { WorkQueue } from '../src/main/workQueue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await sleep(5);
  }
};

describe('WorkQueue (maxConcurrentUpdates)', () => {
  it('never runs more than N at once and starts the next one as soon as one finishes', async () => {
    let active = 0;
    let peak = 0;
    const starts: Record<number, number> = {};
    const ends: Record<number, number> = {};
    const durations = [60, 20, 40, 10, 30, 50, 15, 25, 35, 5];
    const q = new WorkQueue<number>({
      keys: durations.map((_, i) => i),
      concurrency: 3,
      worker: async (i) => {
        starts[i] = Date.now();
        active++;
        peak = Math.max(peak, active);
        await sleep(durations[i]);
        active--;
        ends[i] = Date.now();
        return { state: 'done' };
      },
    });
    await q.run();
    expect(peak).toBe(3);
    expect(q.counts()).toMatchObject({ done: 10, running: 0, queued: 0 });
    // item 3 (4th in line) starts right after the first of 0..2 finished (item 1, 20 ms), not after all three
    expect(starts[3] - ends[1]).toBeLessThan(15);
    expect(starts[3]).toBeLessThan(ends[0]);
  });

  it('failures and timeouts do not stop the queue; concurrency 1 is strictly sequential', async () => {
    let active = 0;
    let peak = 0;
    const q = new WorkQueue<number>({
      keys: [1, 2, 3, 4],
      concurrency: 1,
      itemTimeoutMs: 50,
      worker: async (k, ctx) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (k === 2) throw new Error('boom');
          if (k === 3) await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
          return { state: 'done' };
        } finally {
          active--;
        }
      },
    });
    await q.run();
    expect(peak).toBe(1);
    expect(q.items.map((i) => [i.key, i.state, i.message])).toEqual([
      [1, 'done', undefined],
      [2, 'failed', 'boom'],
      [3, 'failed', 'таймаут'],
      [4, 'done', undefined],
    ]);
  });

  it('requeue sends an item to the end once, then skips it', async () => {
    const order: number[] = [];
    const q = new WorkQueue<number>({
      keys: [1, 2, 3],
      concurrency: 1,
      worker: async (k) => {
        order.push(k);
        return k === 1 ? { state: 'requeue', message: 'зайнятий' } : { state: 'done' };
      },
    });
    await q.run();
    expect(order).toEqual([1, 2, 3, 1]);
    expect(q.items[0]).toMatchObject({ state: 'skipped', attempts: 2, message: 'зайнятий' });
  });

  it('cancel stops starting new items', async () => {
    const q = new WorkQueue<number>({ keys: [1, 2, 3, 4, 5], concurrency: 2, worker: async (_k, ctx) => (await sleep(30), ctx.signal.aborted ? { state: 'skipped' } : { state: 'done' }) });
    const done = q.run();
    await sleep(10);
    q.cancel();
    await done;
    expect(q.counts().cancelled).toBe(3);
    expect(q.counts().queued).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

function fakeClub(n: number) {
  const pcs: PcRecord[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, ip: `10.0.0.${i + 1}`, mac: `aa:bb:cc:dd:ee:${String(i + 1).padStart(2, '0')}`, zone: i < 2 ? 'Stream' : 'Regular' }));
  const status = (): AgentStatus => ({ state: 'idle', job: null, lastJob: null, nextRunAt: null, pendingPower: null, configRev: null, steamcmdInstalled: true, dryRun: true, occupancy: 'free' });
  const rts = new Map<number, PcRuntime>(pcs.map((p) => [p.id, { pcId: p.id, link: 'online', info: null, status: status(), sleeping: false, lastSeen: null, lastError: null, wolSentAt: null }]));
  const bus = new EventEmitter();
  const changed = () => bus.emit('change');
  let running = 0;
  let peak = 0;
  const started: Array<{ id: number; mode: JobMode }> = [];
  const woken: number[] = [];
  const occupiedOnce = new Set<number>();
  const host: QueueHost = {
    pcs: () => pcs,
    runtime: (id) => rts.get(id)!,
    wake: async (id) => {
      woken.push(id);
    },
    startJob: async (id, mode) => {
      if (occupiedOnce.delete(id)) throw Object.assign(new Error('ПК зайнятий гравцем'), { code: ERR_OCCUPIED });
      const jobId = `job-${id}`;
      started.push({ id, mode });
      running++;
      peak = Math.max(peak, running);
      const rt = rts.get(id)!;
      const job: JobState = { id: jobId, mode, startedAt: new Date().toISOString(), steps: [], apps: [], progress: null, errors: 0 };
      rt.status = { ...rt.status!, state: 'updating', job };
      setTimeout(() => {
        running--;
        rt.status = { ...rt.status!, state: 'idle', job: null, lastJob: { ...job, finishedAt: new Date().toISOString(), result: 'ok' } };
        changed();
      }, 20 + id * 3);
      return jobId;
    },
    waitFor: (id, pred, ms, signal) =>
      new Promise((resolve) => {
        const check = () => {
          if (pred(rts.get(id)!)) finish(true);
        };
        const finish = (v: boolean) => {
          clearTimeout(t);
          bus.off('change', check);
          resolve(v);
        };
        const t = setTimeout(() => finish(false), ms);
        signal?.addEventListener('abort', () => finish(false), { once: true });
        bus.on('change', check);
        check();
      }),
    log: () => undefined,
  };
  return { pcs, rts, host, changed, started, woken, occupiedOnce, peak: () => peak };
}

describe('MaintenanceQueue (bandwidth control)', () => {
  it('runs at most N PCs at once, zone order first, wakes offline PCs, requeues occupied ones', async () => {
    const club = fakeClub(8);
    // PC 5 is off and comes up 30 ms after WoL; PC 3 has a player the first time
    club.rts.get(5)!.link = 'offline';
    club.occupiedOnce.add(3);
    const origWake = club.host.wake;
    club.host.wake = async (id, reason) => {
      await origWake(id, reason);
      setTimeout(() => {
        club.rts.get(id)!.link = 'online';
        club.changed();
      }, 30);
    };
    const q = new MaintenanceQueue(club.host, { wakeTimeoutMs: 1000, jobTimeoutMs: 2000 });
    expect(q.start({ pcIds: [3, 4, 5, 6, 7, 8, 1, 2], mode: 'scheduled', concurrency: 3, zoneOrder: ['Stream'], reason: 'тест' })).toBe(true);
    expect(q.start({ pcIds: [1], mode: 'test', concurrency: 1, zoneOrder: [], reason: 'другий' })).toBe(false); // one queue at a time
    await waitUntil(() => !q.isRunning(), 5000);

    expect(club.peak()).toBeLessThanOrEqual(3);
    expect(club.peak()).toBe(3);
    expect(club.started.slice(0, 2).map((s) => s.id)).toEqual([1, 2]); // Stream first
    expect(club.started.every((s) => s.mode === 'scheduled')).toBe(true);
    expect(club.woken).toEqual([5]);
    expect(club.started.at(-1)!.id).toBe(3); // occupied PC went to the end
    const st = q.status()!;
    expect(st.counts).toMatchObject({ done: 8, failed: 0, running: 0, queued: 0 });
    expect(st.active).toBe(false);
  });

  it('an offline PC that never answers fails after the WoL timeout, the rest continue', async () => {
    const club = fakeClub(3);
    club.rts.get(2)!.link = 'offline';
    const q = new MaintenanceQueue(club.host, { wakeTimeoutMs: 80, jobTimeoutMs: 2000 });
    q.start({ pcIds: [1, 2, 3], mode: 'test', concurrency: 1, zoneOrder: [], reason: 'тест' });
    await waitUntil(() => !q.isRunning(), 3000);
    const items = q.status()!.items;
    expect(items.find((i) => i.pcId === 2)).toMatchObject({ state: 'failed' });
    expect(items.find((i) => i.pcId === 2)!.message).toMatch(/не підключився/);
    expect(items.filter((i) => i.state === 'done').map((i) => i.pcId)).toEqual([1, 3]);
  });
});

/* ------------------------------------------------------------------ */

describe('OTA agent update', () => {
  it('serves the file only under its random path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-ota-'));
    const file = path.join(dir, 'VadeAgent.exe');
    fs.writeFileSync(file, Buffer.from('MZ-agent'));
    const s = new UpdateServer('127.0.0.1');
    await s.start(file, 0);
    const ok = await fetch(s.url('127.0.0.1'));
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('MZ-agent');
    expect((await fetch(`http://127.0.0.1:${s.port}/vade-agent/guess/VadeAgent.exe`)).status).toBe(404);
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updates, skips same version, detects rollback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-ota-'));
    const file = path.join(dir, 'VadeAgent.exe');
    fs.writeFileSync(file, 'MZ');
    const bus = new EventEmitter();
    const rts = new Map<number, PcRuntime>(
      [1, 2, 3].map((id) => [id, { pcId: id, link: 'online', info: { protocol: 1, version: id === 2 ? '0.3.0' : '0.2.0', hostname: `pc${id}`, nics: [], os: '', startedAt: '' }, status: null, sleeping: false, lastSeen: null, lastError: null, wolSentAt: null }]),
    );
    const urls: string[] = [];
    const host: UpdaterHost = {
      runtime: (id) => rts.get(id)!,
      localAddressOf: () => '127.0.0.1',
      selfUpdate: async (id, args) => {
        urls.push(args.url);
        const rt = rts.get(id)!;
        setTimeout(() => {
          rt.link = 'offline';
          bus.emit('c');
          setTimeout(() => {
            rt.link = 'online';
            rt.info = { ...rt.info!, version: id === 3 ? '0.2.0' : args.version }; // PC 3: new version did not start -> rollback
            bus.emit('c');
          }, 20);
        }, 10);
        return { message: 'ok' };
      },
      waitFor: (id, pred, ms) =>
        new Promise((resolve) => {
          const check = () => pred(rts.get(id)!) && done(true);
          const done = (v: boolean) => (clearTimeout(t), bus.off('c', check), resolve(v));
          const t = setTimeout(() => done(false), ms);
          bus.on('c', check);
          check();
        }),
      log: () => undefined,
    };
    const u = new AgentUpdater(host, { restartStartMs: 500, comeBackMs: 300 }, 4, 0, '127.0.0.1');
    await u.start([1, 2, 3], { path: file, version: '0.3.0', sha256: 'f'.repeat(64), size: 2, bundled: true }, false);
    await waitUntil(() => !u.isRunning(), 5000);
    const items = u.status()!.items;
    expect(items.find((i) => i.pcId === 1)).toMatchObject({ state: 'done', message: '0.2.0 → 0.3.0' });
    expect(items.find((i) => i.pcId === 2)).toMatchObject({ state: 'skipped' });
    expect(items.find((i) => i.pcId === 3)!.message).toMatch(/відкат/);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vade-agent\/[0-9a-f]{24}\/VadeAgent\.exe$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
