import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_PCS, type PcRuntime } from '@vade/protocol';
import { AdminStore } from '../src/main/store';
import { defaultMapLayout, minGridSize, sanitizeMapLayout, type MapLayout } from '../src/shared/mapLayout';
import { addWall, movePc, pcsInRect, placePc, resizeGrid, rotateLandmark, wallTo, zoneNear } from '../src/renderer/map/mapEdit';
import { mapTone } from '../src/renderer/map/mapStatus';

const pos = (l: MapLayout, id: number) => {
  const p = l.pcs.find((s) => s.id === id);
  if (!p) throw new Error(`PC ${id} is not on the map`);
  return p;
};

describe('seed club map', () => {
  const l = defaultMapLayout();

  it('has a slot for every table 1..29, one per cell, inside a ~24×14 grid', () => {
    expect(l.cols).toBe(24);
    expect(l.rows).toBe(14);
    expect(l.pcs.map((p) => p.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    expect(new Set(l.pcs.map((p) => `${p.x},${p.y}`)).size).toBe(29);
    for (const p of l.pcs) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(l.cols);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(l.rows);
    }
    // every seeded PC has its slot; 8–11 and 20–22 are inactive slots until they are added
    for (const pc of SEED_PCS) expect(l.pcs.some((s) => s.id === pc.id)).toBe(true);
  });

  it('is already normalised (sanitize does not change it)', () => {
    expect(sanitizeMapLayout(l)).toEqual(l);
  });

  const vertical = (ids: number[]) => {
    const x = pos(l, ids[0]).x;
    ids.forEach((id, i) => {
      expect(pos(l, id).x).toBe(x);
      if (i) expect(pos(l, id).y).toBeGreaterThan(pos(l, ids[i - 1]).y);
    });
  };
  const horizontal = (ids: number[]) => {
    const y = pos(l, ids[0]).y;
    ids.forEach((id, i) => {
      expect(pos(l, id).y).toBe(y);
      if (i) expect(pos(l, id).x).toBeGreaterThan(pos(l, ids[i - 1]).x);
    });
  };

  it('matches the hall: rows and columns in the right order', () => {
    vertical([1, 2, 3, 4, 5]);
    horizontal([6, 7, 8, 9]);
    horizontal([12, 13, 14, 15, 16, 17]);
    horizontal([10, 11]);
    horizontal([21, 22]);
    horizontal([24, 23]);
    vertical([25, 26, 27, 28, 29]);
  });

  it('places the groups where the club has them', () => {
    // 1–5: top centre; 6–9 above 12–17 in the bottom-left block
    expect(pos(l, 1).y).toBeLessThanOrEqual(1);
    expect(pos(l, 1).x).toBeGreaterThan(6);
    expect(pos(l, 6).x).toBeLessThan(6);
    expect(pos(l, 6).y).toBeLessThan(pos(l, 12).y);
    expect(pos(l, 12).y).toBeGreaterThan(l.rows / 2);
    // 10–11 at the bottom, right of the left block
    expect(pos(l, 10).y).toBeGreaterThan(l.rows / 2);
    expect(pos(l, 10).x).toBeGreaterThan(pos(l, 17).x);
    // Stream booths: 18 in the middle, 19 below it, right of the 1–5 column
    expect(pos(l, 19).x).toBe(pos(l, 18).x);
    expect(pos(l, 19).y).toBeGreaterThan(pos(l, 18).y);
    expect(pos(l, 18).x).toBeGreaterThan(pos(l, 5).x);
    // middle-right room: 20 directly under 21, the 24/23 pair below, room left of the 25–29 column
    expect(pos(l, 20)).toEqual({ id: 20, x: pos(l, 21).x, y: pos(l, 21).y + 1 });
    expect(pos(l, 24).y).toBeGreaterThan(pos(l, 20).y);
    expect(pos(l, 22).x).toBeGreaterThan(pos(l, 18).x);
    expect(pos(l, 25).x).toBeGreaterThan(pos(l, 22).x);
    // landmarks: entrance top-left, reception left-middle, WC left of PC 5 and 18
    const lm = Object.fromEntries(l.landmarks.map((m) => [m.kind, m]));
    expect(lm.entrance.x).toBeLessThan(4);
    expect(lm.entrance.y).toBeLessThan(2);
    expect(lm.reception.x).toBeLessThan(3);
    expect(lm.reception.y).toBeGreaterThan(3);
    expect(lm.wc.x).toBeLessThan(pos(l, 5).x);
    expect(Math.abs(lm.wc.y - pos(l, 5).y)).toBeLessThanOrEqual(1);
    expect(l.landmarks.some((m) => m.kind === 'extinguisher')).toBe(true);
    expect(l.labels.map((t) => t.text)).toEqual(expect.arrayContaining(['Regular', 'Stream']));
  });
});

describe('sanitizeMapLayout', () => {
  it('rejects things that are not a layout', () => {
    expect(() => sanitizeMapLayout(null)).toThrow();
    expect(() => sanitizeMapLayout([1, 2])).toThrow();
    expect(() => sanitizeMapLayout('x')).toThrow();
  });

  it('drops broken entries, duplicate numbers / cells and diagonal walls; clamps into the grid', () => {
    const l = sanitizeMapLayout({
      cols: 10,
      rows: 8,
      pcs: [
        { id: 1, x: 2, y: 2 },
        { id: 1, x: 3, y: 3 }, // duplicate number
        { id: 2, x: 2, y: 2 }, // same cell
        { id: 3, x: 99, y: -4 }, // clamped
        { id: 0, x: 1, y: 1 },
        { id: 'x', x: 1, y: 1 },
        null,
      ],
      walls: [
        { x1: 0, y1: 0, x2: 5, y2: 0 },
        { x1: 5, y1: 0, x2: 0, y2: 0 }, // same wall reversed
        { x1: 0, y1: 0, x2: 3, y2: 3 }, // diagonal
        { x1: 1, y1: 1, x2: 1, y2: 1 }, // zero length
        { x1: 4, y1: 6, x2: 4, y2: 50 }, // clamped to the grid
      ],
      landmarks: [
        { id: 'a', kind: 'wc', x: 3.3, y: 4.2, rot: 90 },
        { id: 'a', kind: 'entrance', x: 1, y: 1, rot: 45 }, // duplicate id, bad rotation
        { kind: 'teleport', x: 1, y: 1 },
      ],
      labels: [{ text: '  VIP  ', x: 4, y: 4, zone: 'Stream' }, { text: '', x: 1, y: 1 }],
    });
    expect(l.pcs).toEqual([
      { id: 1, x: 2, y: 2 },
      { id: 3, x: 9, y: 0 },
    ]);
    expect(l.walls).toEqual([
      { x1: 0, y1: 0, x2: 5, y2: 0 },
      { x1: 4, y1: 6, x2: 4, y2: 8 },
    ]);
    expect(l.landmarks).toHaveLength(2);
    expect(l.landmarks[0]).toEqual({ id: 'a', kind: 'wc', x: 3.5, y: 4, rot: 90 });
    expect(l.landmarks[1].id).not.toBe('a');
    expect(l.landmarks[1].rot).toBe(0);
    expect(l.labels).toEqual([{ id: 'label-1', text: 'VIP', x: 4, y: 4, zone: 'Stream' }]);
  });

  it('keeps the grid within limits', () => {
    const l = sanitizeMapLayout({ cols: 1, rows: 1000, pcs: [], walls: [], landmarks: [], labels: [] });
    expect(l.cols).toBe(6);
    expect(l.rows).toBe(60);
  });
});

describe('AdminStore map_layout.json', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-map-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('writes the seed hall on first start', () => {
    const dir = tmp();
    const store = new AdminStore(dir);
    const file = path.join(dir, 'map_layout.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(defaultMapLayout());
    expect(store.mapLayout).toEqual(defaultMapLayout());
  });

  it('saves atomically with a .bak and reloads the saved layout', () => {
    const dir = tmp();
    const store = new AdminStore(dir);
    const next = movePc(store.mapLayout, 1, 0, 3);
    const saved = store.saveMapLayout(next);
    expect(pos(saved, 1)).toEqual({ id: 1, x: 0, y: 3 });
    expect(fs.existsSync(path.join(dir, 'map_layout.json.bak'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'map_layout.json.tmp'))).toBe(false);
    expect(pos(new AdminStore(dir).mapLayout, 1)).toEqual({ id: 1, x: 0, y: 3 });
    expect(() => store.saveMapLayout('nonsense')).toThrow();
    expect(pos(new AdminStore(dir).mapLayout, 1)).toEqual({ id: 1, x: 0, y: 3 });
  });

  it('falls back to the .bak when the file is damaged and never overwrites it with the seed', () => {
    const dir = tmp();
    const store = new AdminStore(dir);
    store.saveMapLayout(movePc(store.mapLayout, 2, 0, 5)); // .bak = seed
    store.saveMapLayout(movePc(store.mapLayout, 3, 0, 6)); // .bak = PC 2 moved
    const file = path.join(dir, 'map_layout.json');
    fs.writeFileSync(file, '{ broken');
    const reloaded = new AdminStore(dir).mapLayout;
    expect(pos(reloaded, 2)).toEqual({ id: 2, x: 0, y: 5 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });
});

describe('map editing', () => {
  it('moving a PC onto another swaps them', () => {
    const l = defaultMapLayout();
    const a = pos(l, 1);
    const b = pos(l, 2);
    const n = movePc(l, 1, b.x, b.y);
    expect(pos(n, 1)).toMatchObject({ x: b.x, y: b.y });
    expect(pos(n, 2)).toMatchObject({ x: a.x, y: a.y });
    expect(movePc(l, 1, a.x, a.y)).toBe(l);
  });

  it('places only into free cells', () => {
    const l = defaultMapLayout();
    const p1 = pos(l, 1);
    expect(placePc(l, 30, p1.x, p1.y)).toBe(l);
    expect(pos(placePc(l, 30, 0, 13), 30)).toEqual({ id: 30, x: 0, y: 13 });
  });

  it('walls are axis-aligned, normalised and not duplicated', () => {
    const l = { ...defaultMapLayout(), walls: [] };
    const w = wallTo(l, { x: 5, y: 5 }, 2.2, 5.9);
    expect(w).toEqual({ x1: 5, y1: 5, x2: 2, y2: 5 });
    const n = addWall(l, w);
    expect(n.walls).toEqual([{ x1: 2, y1: 5, x2: 5, y2: 5 }]);
    expect(addWall(n, { x1: 5, y1: 5, x2: 2, y2: 5 })).toBe(n);
    expect(addWall(n, { x1: 1, y1: 1, x2: 1, y2: 1 })).toBe(n);
  });

  it('frame selection picks the cells it touches', () => {
    const l = defaultMapLayout();
    expect(pcsInRect(l, 0.5, 9.5, 4.2, 10.5).sort((a, b) => a - b)).toEqual([6, 7, 8, 9]);
    expect(pcsInRect(l, 4.2, 10.5, 0.5, 9.5).sort((a, b) => a - b)).toEqual([6, 7, 8, 9]);
  });

  it('the grid never shrinks below what is placed', () => {
    const l = defaultMapLayout();
    const min = minGridSize(l);
    expect(resizeGrid(l, 3, 3)).toMatchObject({ cols: min.cols, rows: min.rows });
    expect(resizeGrid(l, 30, 20)).toMatchObject({ cols: 30, rows: 20 });
  });

  it('rotates the entrance arrow in 90° steps', () => {
    let l = defaultMapLayout();
    for (let i = 0; i < 4; i++) l = rotateLandmark(l, 'entrance');
    expect(l.landmarks.find((m) => m.id === 'entrance')?.rot).toBe(0);
    expect(rotateLandmark(l, 'entrance').landmarks.find((m) => m.id === 'entrance')?.rot).toBe(90);
  });

  it('a new PC on an empty slot gets the zone of its nearest neighbour', () => {
    const l = defaultMapLayout();
    const zones = new Map(SEED_PCS.map((p) => [p.id, p.zone]));
    expect(zoneNear(l, (id) => zones.get(id), 8)).toBe('Regular');
    expect(zoneNear(l, () => undefined, 8)).toBe('Regular');
  });
});

describe('map colours', () => {
  const rt = (over: Omit<Partial<PcRuntime>, 'status'> & { status?: Partial<NonNullable<PcRuntime['status']>> | null }): PcRuntime =>
    ({
      pcId: 1,
      link: 'online',
      info: null,
      sleeping: false,
      lastSeen: null,
      lastError: null,
      wolSentAt: null,
      ...over,
      status: over.status === null ? null : { state: 'idle', job: null, lastJob: null, nextRunAt: null, pendingPower: null, configRev: null, steamcmdInstalled: true, dryRun: false, ...over.status },
    }) as PcRuntime;

  it('maps runtime state to the legend', () => {
    expect(mapTone(undefined, false)).toBe('empty');
    expect(mapTone(undefined, true)).toBe('offline');
    expect(mapTone(rt({ link: 'offline', status: null, sleeping: true }), true)).toBe('sleep');
    expect(mapTone(rt({ status: { occupancy: 'free' } }), true)).toBe('free');
    expect(mapTone(rt({ status: { occupancy: 'occupied' } }), true)).toBe('busy');
    expect(mapTone(rt({ status: { occupancy: 'unknown' } }), true)).toBe('online');
    expect(mapTone(rt({ status: { state: 'updating' } }), true)).toBe('work');
    expect(mapTone(rt({ status: { state: 'cleaning' } }), true)).toBe('work');
    expect(mapTone(rt({ link: 'auth-failed', status: null }), true)).toBe('error');
  });
});
