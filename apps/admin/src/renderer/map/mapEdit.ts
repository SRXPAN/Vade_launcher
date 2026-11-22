/** Pure editing operations on the club map (no React), so they can be unit-tested. */
import { minGridSize, MAP_LIMITS, type LandmarkKind, type MapLayout, type MapWall, type Rotation } from '../../shared/mapLayout';

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Cell under a point (grid units). */
export function snapCell(l: Pick<MapLayout, 'cols' | 'rows'>, x: number, y: number): { x: number; y: number } {
  return { x: clamp(Math.floor(x), 0, l.cols - 1), y: clamp(Math.floor(y), 0, l.rows - 1) };
}

/** Nearest half-cell point for landmarks and labels. */
export function snapHalf(l: Pick<MapLayout, 'cols' | 'rows'>, x: number, y: number): { x: number; y: number } {
  return { x: clamp(Math.round(x * 2) / 2, 0.5, l.cols - 0.5), y: clamp(Math.round(y * 2) / 2, 0.5, l.rows - 0.5) };
}

/** Nearest grid corner for walls. */
export function snapCorner(l: Pick<MapLayout, 'cols' | 'rows'>, x: number, y: number): { x: number; y: number } {
  return { x: clamp(Math.round(x), 0, l.cols), y: clamp(Math.round(y), 0, l.rows) };
}

/** Wall from a fixed corner towards the pointer, kept horizontal or vertical (whichever is longer). */
export function wallTo(l: Pick<MapLayout, 'cols' | 'rows'>, start: { x: number; y: number }, x: number, y: number): MapWall {
  const end = snapCorner(l, x, y);
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
    ? { x1: start.x, y1: start.y, x2: end.x, y2: start.y }
    : { x1: start.x, y1: start.y, x2: start.x, y2: end.y };
}

export function pcAt(l: MapLayout, x: number, y: number): number | null {
  return l.pcs.find((p) => p.x === x && p.y === y)?.id ?? null;
}

/** Moves a PC slot; dropping it on another slot swaps the two. */
export function movePc(l: MapLayout, id: number, x: number, y: number): MapLayout {
  const me = l.pcs.find((p) => p.id === id);
  if (!me || (me.x === x && me.y === y)) return l;
  const other = pcAt(l, x, y);
  return {
    ...l,
    pcs: l.pcs.map((p) => (p.id === id ? { ...p, x, y } : p.id === other ? { ...p, x: me.x, y: me.y } : p)),
  };
}

/** Puts a PC that is not on the map yet into a free cell; returns the layout unchanged if the cell is taken. */
export function placePc(l: MapLayout, id: number, x: number, y: number): MapLayout {
  if (l.pcs.some((p) => p.id === id) || pcAt(l, x, y) != null) return l;
  return { ...l, pcs: [...l.pcs, { id, x, y }] };
}

export function removePc(l: MapLayout, id: number): MapLayout {
  return { ...l, pcs: l.pcs.filter((p) => p.id !== id) };
}

const sameWall = (a: MapWall, b: MapWall) =>
  (a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2) || (a.x1 === b.x2 && a.y1 === b.y2 && a.x2 === b.x1 && a.y2 === b.y1);

export function addWall(l: MapLayout, w: MapWall): MapLayout {
  if ((w.x1 === w.x2 && w.y1 === w.y2) || (w.x1 !== w.x2 && w.y1 !== w.y2)) return l;
  if (l.walls.some((x) => sameWall(x, w)) || l.walls.length >= MAP_LIMITS.maxWalls) return l;
  const [a, b] = w.x1 > w.x2 || w.y1 > w.y2 ? [{ x: w.x2, y: w.y2 }, { x: w.x1, y: w.y1 }] : [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }];
  return { ...l, walls: [...l.walls, { x1: a.x, y1: a.y, x2: b.x, y2: b.y }] };
}

export function removeWall(l: MapLayout, index: number): MapLayout {
  return { ...l, walls: l.walls.filter((_, i) => i !== index) };
}

function newId(existing: Array<{ id: string }>, prefix: string): string {
  let n = 1;
  while (existing.some((e) => e.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function addLandmark(l: MapLayout, kind: LandmarkKind, x: number, y: number): MapLayout {
  return { ...l, landmarks: [...l.landmarks, { id: newId(l.landmarks, kind), kind, x, y, rot: 0 }] };
}

export function moveLandmark(l: MapLayout, id: string, x: number, y: number): MapLayout {
  const m = l.landmarks.find((v) => v.id === id);
  if (!m || (m.x === x && m.y === y)) return l;
  return { ...l, landmarks: l.landmarks.map((v) => (v.id === id ? { ...v, x, y } : v)) };
}

export function rotateLandmark(l: MapLayout, id: string): MapLayout {
  return { ...l, landmarks: l.landmarks.map((v) => (v.id === id ? { ...v, rot: ((v.rot + 90) % 360) as Rotation } : v)) };
}

export function removeLandmark(l: MapLayout, id: string): MapLayout {
  return { ...l, landmarks: l.landmarks.filter((v) => v.id !== id) };
}

export function addLabel(l: MapLayout, text: string, zone: string | undefined, x: number, y: number): MapLayout {
  const t = text.trim().slice(0, MAP_LIMITS.maxLabelLength);
  if (!t) return l;
  return { ...l, labels: [...l.labels, { id: newId(l.labels, 'label'), text: t, x, y, ...(zone ? { zone } : {}) }] };
}

export function moveLabel(l: MapLayout, id: string, x: number, y: number): MapLayout {
  const t = l.labels.find((v) => v.id === id);
  if (!t || (t.x === x && t.y === y)) return l;
  return { ...l, labels: l.labels.map((v) => (v.id === id ? { ...v, x, y } : v)) };
}

export function removeLabel(l: MapLayout, id: string): MapLayout {
  return { ...l, labels: l.labels.filter((v) => v.id !== id) };
}

/** Changes the grid size, never cutting off placed elements. */
export function resizeGrid(l: MapLayout, cols: number, rows: number): MapLayout {
  const min = minGridSize(l);
  const c = clamp(Math.round(cols) || l.cols, Math.max(min.cols, MAP_LIMITS.minCols), MAP_LIMITS.maxCols);
  const r = clamp(Math.round(rows) || l.rows, Math.max(min.rows, MAP_LIMITS.minRows), MAP_LIMITS.maxRows);
  return c === l.cols && r === l.rows ? l : { ...l, cols: c, rows: r };
}

/** Table numbers whose cells intersect the rectangle (grid units, any corner order). */
export function pcsInRect(l: MapLayout, ax: number, ay: number, bx: number, by: number): number[] {
  const [x0, x1] = ax < bx ? [ax, bx] : [bx, ax];
  const [y0, y1] = ay < by ? [ay, by] : [by, ay];
  return l.pcs.filter((p) => p.x + 1 > x0 && p.x < x1 && p.y + 1 > y0 && p.y < y1).map((p) => p.id);
}

/** Zone for a new PC on an empty slot: the zone of the nearest PC that exists. */
export function zoneNear(l: MapLayout, zoneOf: (id: number) => string | undefined, id: number): string {
  const me = l.pcs.find((p) => p.id === id);
  let best: { d: number; zone: string } | null = null;
  for (const p of l.pcs) {
    const zone = p.id === id ? undefined : zoneOf(p.id);
    if (!me || !zone) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (!best || d < best.d) best = { d, zone };
  }
  return best?.zone ?? 'Regular';
}
