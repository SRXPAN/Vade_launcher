/**
 * Club floor map shown on the "Комп'ютери" tab (admin only, never sent to agents).
 * Stored in %APPDATA%\Vade Launcher\data\map_layout.json.
 *
 * Coordinates are in grid units, origin top-left:
 *  - PC slots occupy one cell: x = column, y = row (integers);
 *  - walls run along grid lines between corner points (integers);
 *  - landmarks and labels are centre points, snapped to half a cell.
 * A slot is keyed by the table number, so a slot without a PC in pcs.json is drawn as an inactive place.
 */

export type LandmarkKind =
  | 'entrance'
  | 'reception'
  | 'wc'
  | 'extinguisher'
  | 'bar'
  | 'sofa'
  | 'console'
  | 'server'
  | 'exit';
export type Rotation = 0 | 90 | 180 | 270;

export interface MapPcSlot {
  id: number;
  x: number;
  y: number;
}

export interface MapWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapLandmark {
  id: string;
  kind: LandmarkKind;
  x: number;
  y: number;
  /** Rotation in 90° clockwise steps */
  rot: Rotation;
}

export interface MapLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Zone the label names: colours it like the zone tag */
  zone?: string;
}

export interface MapZoneBox {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Hex colour (#rrggbb) for the translucent zone fill and border */
  color: string;
}

export interface MapLayout {
  version: 1;
  cols: number;
  rows: number;
  pcs: MapPcSlot[];
  walls: MapWall[];
  landmarks: MapLandmark[];
  labels: MapLabel[];
  zones: MapZoneBox[];
}

export const LANDMARK_KINDS: LandmarkKind[] = [
  'entrance',
  'exit',
  'reception',
  'wc',
  'bar',
  'sofa',
  'console',
  'server',
  'extinguisher',
];

export const LANDMARK_TITLES: Record<LandmarkKind, string> = {
  entrance: 'Вхід',
  exit: 'Вихід / Двері',
  reception: 'Рецепція / адмін',
  wc: 'Туалет (WC)',
  bar: 'Бар / Холодильник',
  sofa: 'Диван / Зона очікування',
  console: 'Консольна зона (PS5)',
  server: 'Серверна / Роутер',
  extinguisher: 'Вогнегасник',
};

export const ZONE_COLORS = [
  { label: 'Синій', value: '#4f8cff' },
  { label: 'Фіолетовий', value: '#9a8bff' },
  { label: 'Золотий (VIP)', value: '#eab308' },
  { label: 'Смарагдовий', value: '#10b981' },
  { label: 'Помаранчевий', value: '#f97316' },
  { label: 'Червоний', value: '#ef4444' },
  { label: 'Бірюзовий', value: '#06b6d4' },
  { label: 'Сірий', value: '#64748b' },
] as const;

export const MAP_LIMITS = {
  minCols: 6,
  maxCols: 80,
  minRows: 4,
  maxRows: 60,
  maxPcs: 400,
  maxWalls: 2000,
  maxLandmarks: 200,
  maxLabels: 200,
  maxZones: 50,
  maxLabelLength: 40,
  maxZoneNameLength: 40,
} as const;

/* ------------------------------------------------------------------ */
/* Seed: the real club hall                                            */
/* ------------------------------------------------------------------ */

const row = (ids: number[], x0: number, y: number): MapPcSlot[] => ids.map((id, i) => ({ id, x: x0 + i, y }));
const column = (ids: number[], x: number, y0: number): MapPcSlot[] => ids.map((id, i) => ({ id, x, y: y0 + i }));
const w = (x1: number, y1: number, x2: number, y2: number): MapWall => ({ x1, y1, x2, y2 });

/**
 * 24×14 cells. Left: entrance (top) and reception; bottom-left block 6–9 / 12–17;
 * centre: column 1–5 with the WC to its left, pair 10–11 at the bottom;
 * centre-right: Stream booths 18 and 19; middle-right room 21 22 / 20 / 24 23; far right: column 25–29.
 */
export function defaultMapLayout(): MapLayout {
  return {
    version: 1,
    cols: 24,
    rows: 14,
    pcs: [
      ...column([1, 2, 3, 4, 5], 10, 1),
      ...row([6, 7, 8, 9], 1, 10),
      ...row([12, 13, 14, 15, 16, 17], 1, 12),
      ...row([10, 11], 9, 12),
      { id: 18, x: 13, y: 6 },
      { id: 19, x: 13, y: 9 },
      ...row([21, 22], 17, 2),
      { id: 20, x: 17, y: 3 },
      ...row([24, 23], 17, 8),
      ...column([25, 26, 27, 28, 29], 22, 2),
    ],
    walls: [
      // outer walls, entrance gap at the top-left (x 1..3)
      w(0, 0, 1, 0),
      w(3, 0, 24, 0),
      w(24, 0, 24, 14),
      w(0, 14, 24, 14),
      w(0, 0, 0, 14),
      // WC, door on the left
      w(7, 4, 9, 4),
      w(9, 4, 9, 7),
      w(7, 7, 9, 7),
      w(7, 4, 7, 5),
      w(7, 6, 7, 7),
      // Stream booths (18 above, 19 below), doors on the left
      w(12, 5, 15, 5),
      w(12, 8, 15, 8),
      w(12, 11, 15, 11),
      w(15, 5, 15, 11),
      w(12, 5, 12, 6),
      w(12, 7, 12, 9),
      w(12, 10, 12, 11),
      // middle-right room, door on the left (y 2..4)
      w(15, 0, 15, 2),
      w(15, 4, 15, 5),
      w(15, 11, 20, 11),
      w(20, 0, 20, 11),
    ],
    landmarks: [
      { id: 'entrance', kind: 'entrance', x: 2, y: 1, rot: 0 },
      { id: 'reception', kind: 'reception', x: 1.5, y: 6, rot: 0 },
      { id: 'wc', kind: 'wc', x: 8, y: 5.5, rot: 0 },
      { id: 'extinguisher-1', kind: 'extinguisher', x: 11.5, y: 0.5, rot: 0 },
      { id: 'extinguisher-2', kind: 'extinguisher', x: 23.5, y: 13.5, rot: 0 },
    ],
    labels: [
      { id: 'zone-hall', text: 'Regular', x: 3, y: 9.5, zone: 'Regular' },
      { id: 'zone-stream', text: 'Stream', x: 13.5, y: 4.5, zone: 'Stream' },
      { id: 'zone-room', text: 'Regular', x: 18, y: 5.5, zone: 'Regular' },
      { id: 'zone-right', text: 'Regular', x: 22.5, y: 1.5, zone: 'Regular' },
    ],
    zones: [],
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const half = (v: number) => Math.round(v * 2) / 2;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Smallest grid that still contains every element (the editor never shrinks below it). */
export function minGridSize(l: Pick<MapLayout, 'pcs' | 'walls' | 'landmarks' | 'labels'> & { zones?: MapZoneBox[] }): { cols: number; rows: number } {
  let cols: number = MAP_LIMITS.minCols;
  let rows: number = MAP_LIMITS.minRows;
  for (const p of l.pcs) {
    cols = Math.max(cols, p.x + 1);
    rows = Math.max(rows, p.y + 1);
  }
  for (const s of l.walls) {
    cols = Math.max(cols, s.x1, s.x2);
    rows = Math.max(rows, s.y1, s.y2);
  }
  for (const m of [...l.landmarks, ...l.labels]) {
    cols = Math.max(cols, Math.ceil(m.x + 0.5));
    rows = Math.max(rows, Math.ceil(m.y + 0.5));
  }
  for (const z of l.zones ?? []) {
    cols = Math.max(cols, z.x + z.w);
    rows = Math.max(rows, z.y + z.h);
  }
  return { cols, rows };
}

function cleanId(v: unknown, used: Set<string>, prefix: string): string {
  let id = typeof v === 'string' ? v.trim().slice(0, 40) : '';
  if (!id || used.has(id)) {
    let n = used.size + 1;
    while (used.has(`${prefix}-${n}`)) n++;
    id = `${prefix}-${n}`;
  }
  used.add(id);
  return id;
}

/**
 * Normalises a layout from disk or from the renderer: drops broken entries, duplicate table numbers,
 * two slots in one cell, zero-length or diagonal walls; clamps everything into the grid.
 * Throws only when the input is not a layout object at all.
 */
export function sanitizeMapLayout(input: unknown): MapLayout {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некоректна карта клубу');
  const src = input as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

  const cols = Math.round(clamp(num(src.cols) ?? 24, MAP_LIMITS.minCols, MAP_LIMITS.maxCols));
  const rows = Math.round(clamp(num(src.rows) ?? 14, MAP_LIMITS.minRows, MAP_LIMITS.maxRows));

  const pcs: MapPcSlot[] = [];
  const ids = new Set<number>();
  const cells = new Set<string>();
  for (const p of arr(src.pcs)) {
    const id = num(p.id);
    const x = num(p.x);
    const y = num(p.y);
    if (id == null || x == null || y == null || !Number.isInteger(id) || id <= 0 || ids.has(id)) continue;
    const cx = Math.round(clamp(x, 0, cols - 1));
    const cy = Math.round(clamp(y, 0, rows - 1));
    if (cells.has(`${cx},${cy}`)) continue;
    ids.add(id);
    cells.add(`${cx},${cy}`);
    pcs.push({ id, x: cx, y: cy });
    if (pcs.length >= MAP_LIMITS.maxPcs) break;
  }

  const walls: MapWall[] = [];
  const seen = new Set<string>();
  for (const s of arr(src.walls)) {
    const c = [s.x1, s.y1, s.x2, s.y2].map(num);
    if (c.some((v) => v == null)) continue;
    let [x1, y1, x2, y2] = c.map((v, i) => Math.round(clamp(v!, 0, i % 2 ? rows : cols)));
    if (x1 !== x2 && y1 !== y2) continue; // walls are horizontal or vertical
    if (x1 === x2 && y1 === y2) continue;
    if (x1 > x2 || y1 > y2) [x1, y1, x2, y2] = [x2, y2, x1, y1];
    const key = `${x1},${y1},${x2},${y2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    walls.push({ x1, y1, x2, y2 });
    if (walls.length >= MAP_LIMITS.maxWalls) break;
  }

  const landmarkIds = new Set<string>();
  const landmarks: MapLandmark[] = [];
  for (const m of arr(src.landmarks)) {
    const kind = m.kind as LandmarkKind;
    const x = num(m.x);
    const y = num(m.y);
    if (!LANDMARK_KINDS.includes(kind) || x == null || y == null) continue;
    const rot = ([0, 90, 180, 270] as const).find((r) => r === m.rot) ?? 0;
    landmarks.push({ id: cleanId(m.id, landmarkIds, kind), kind, x: half(clamp(x, 0.5, cols - 0.5)), y: half(clamp(y, 0.5, rows - 0.5)), rot });
    if (landmarks.length >= MAP_LIMITS.maxLandmarks) break;
  }

  const labelIds = new Set<string>();
  const labels: MapLabel[] = [];
  for (const t of arr(src.labels)) {
    const text = typeof t.text === 'string' ? t.text.trim().slice(0, MAP_LIMITS.maxLabelLength) : '';
    const x = num(t.x);
    const y = num(t.y);
    if (!text || x == null || y == null) continue;
    const label: MapLabel = { id: cleanId(t.id, labelIds, 'label'), text, x: half(clamp(x, 0, cols)), y: half(clamp(y, 0, rows)) };
    if (typeof t.zone === 'string' && t.zone.trim()) label.zone = t.zone.trim().slice(0, 40);
    labels.push(label);
    if (labels.length >= MAP_LIMITS.maxLabels) break;
  }

  const zoneIds = new Set<string>();
  const zones: MapZoneBox[] = [];
  for (const z of arr(src.zones)) {
    const x = num(z.x);
    const y = num(z.y);
    const w = num(z.w);
    const h = num(z.h);
    if (x == null || y == null || w == null || h == null) continue;
    const zx = Math.round(clamp(x, 0, cols - 1));
    const zy = Math.round(clamp(y, 0, rows - 1));
    const zw = Math.round(clamp(w, 1, cols - zx));
    const zh = Math.round(clamp(h, 1, rows - zy));
    const name = typeof z.name === 'string' && z.name.trim() ? z.name.trim().slice(0, MAP_LIMITS.maxZoneNameLength) : 'Зона';
    const color = typeof z.color === 'string' && HEX_COLOR.test(z.color.trim()) ? z.color.trim().toLowerCase() : ZONE_COLORS[0].value;
    zones.push({ id: cleanId(z.id, zoneIds, 'zone'), name, x: zx, y: zy, w: zw, h: zh, color });
    if (zones.length >= MAP_LIMITS.maxZones) break;
  }

  return { version: 1, cols, rows, pcs, walls, landmarks, labels, zones };
}
