/** Pure editing operations on the club map (no React), so they can be unit-tested. */
import {
  minGridSize,
  MAP_LIMITS,
  ZONE_COLORS,
  type LandmarkKind,
  type MapLayout,
  type MapWall,
  type MapZoneBox,
  type Rotation,
} from '../../shared/mapLayout';

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export type EditItemRef =
  | { type: 'pc'; id: number }
  | { type: 'landmark'; id: string }
  | { type: 'label'; id: string }
  | { type: 'zone'; id: string };

export type ZoneHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function itemKey(ref: EditItemRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseItemKey(key: string): EditItemRef | null {
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const type = key.slice(0, idx);
  const rest = key.slice(idx + 1);
  if (type === 'pc') {
    const id = Number(rest);
    return Number.isInteger(id) ? { type: 'pc', id } : null;
  }
  if (type === 'landmark' || type === 'label' || type === 'zone') return { type, id: rest };
  return null;
}

/** Cell under a point (grid units). */
export function snapCell(l: Pick<MapLayout, 'cols' | 'rows'>, x: number, y: number): { x: number; y: number } {
  return { x: clamp(Math.floor(x), 0, l.cols - 1), y: clamp(Math.floor(y), 0, l.rows - 1) };
}

/** Nearest half-cell point for landmarks and labels. */
export function snapHalf(l: Pick<MapLayout, 'cols' | 'rows'>, x: number, y: number): { x: number; y: number } {
  return { x: clamp(Math.round(x * 2) / 2, 0.5, l.cols - 0.5), y: clamp(Math.round(y * 2) / 2, 0.5, l.rows - 0.5) };
}

/** Nearest grid corner for walls and zone boxes. */
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

/** Smallest positive table number unused by both pcs.json and map slots. */
export function nextFreeSlotId(l: Pick<MapLayout, 'pcs'>, existingPcIds: Iterable<number>): number {
  const used = new Set<number>(existingPcIds);
  for (const s of l.pcs) used.add(s.id);
  let id = 1;
  while (used.has(id)) id++;
  return id;
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

/** Puts a PC or empty slot that is not on the map yet into a free cell; returns the layout unchanged if the cell is taken. */
export function placePc(l: MapLayout, id: number, x: number, y: number): MapLayout {
  if (l.pcs.some((p) => p.id === id) || pcAt(l, x, y) != null) return l;
  return { ...l, pcs: [...l.pcs, { id, x, y }] };
}

/** Replaces an empty slot's table number (e.g. binding an existing PC from pcs.json to a reserve slot). */
export function replaceSlotId(l: MapLayout, oldId: number, newId: number): MapLayout {
  if (oldId === newId) return l;
  if (!l.pcs.some((p) => p.id === oldId) || l.pcs.some((p) => p.id === newId)) return l;
  return { ...l, pcs: l.pcs.map((p) => (p.id === oldId ? { ...p, id: newId } : p)) };
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

export function addLandmark(l: MapLayout, kind: LandmarkKind, x: number, y: number, rot: Rotation = 0): MapLayout {
  return { ...l, landmarks: [...l.landmarks, { id: newId(l.landmarks, kind), kind, x, y, rot }] };
}

export function moveLandmark(l: MapLayout, id: string, x: number, y: number): MapLayout {
  const m = l.landmarks.find((v) => v.id === id);
  if (!m || (m.x === x && m.y === y)) return l;
  return { ...l, landmarks: l.landmarks.map((v) => (v.id === id ? { ...v, x, y } : v)) };
}

export function rotateLandmark(l: MapLayout, id: string): MapLayout {
  return rotateLandmarks(l, [id]);
}

export function rotateLandmarks(l: MapLayout, ids: string[]): MapLayout {
  if (!ids.length) return l;
  const set = new Set(ids);
  let changed = false;
  const landmarks = l.landmarks.map((v) => {
    if (!set.has(v.id)) return v;
    changed = true;
    return { ...v, rot: ((v.rot + 90) % 360) as Rotation };
  });
  return changed ? { ...l, landmarks } : l;
}

export function removeLandmark(l: MapLayout, id: string): MapLayout {
  return { ...l, landmarks: l.landmarks.filter((v) => v.id !== id) };
}

export function addLabel(l: MapLayout, text: string, zone: string | undefined, x: number, y: number): MapLayout {
  const t = text.trim().slice(0, MAP_LIMITS.maxLabelLength);
  if (!t) return l;
  return { ...l, labels: [...l.labels, { id: newId(l.labels, 'label'), text: t, x, y, ...(zone ? { zone } : {}) }] };
}

export function updateLabel(l: MapLayout, id: string, text: string, zone: string | undefined): MapLayout {
  const t = text.trim().slice(0, MAP_LIMITS.maxLabelLength);
  if (!t) return l;
  return {
    ...l,
    labels: l.labels.map((v) => (v.id === id ? { id: v.id, text: t, x: v.x, y: v.y, ...(zone ? { zone } : {}) } : v)),
  };
}

export function moveLabel(l: MapLayout, id: string, x: number, y: number): MapLayout {
  const t = l.labels.find((v) => v.id === id);
  if (!t || (t.x === x && t.y === y)) return l;
  return { ...l, labels: l.labels.map((v) => (v.id === id ? { ...v, x, y } : v)) };
}

export function removeLabel(l: MapLayout, id: string): MapLayout {
  return { ...l, labels: l.labels.filter((v) => v.id !== id) };
}

/* ------------------------------------------------------------------ */
/* Zone boxes                                                          */
/* ------------------------------------------------------------------ */

export function addZone(
  l: MapLayout,
  input: { name: string; color: string; x: number; y: number; w: number; h: number },
): MapLayout {
  if (l.zones.length >= MAP_LIMITS.maxZones) return l;
  const x = Math.round(clamp(input.x, 0, l.cols - 1));
  const y = Math.round(clamp(input.y, 0, l.rows - 1));
  const w = Math.round(clamp(input.w, 1, l.cols - x));
  const h = Math.round(clamp(input.h, 1, l.rows - y));
  const name = input.name.trim().slice(0, MAP_LIMITS.maxZoneNameLength) || 'Зона';
  const color = /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color.toLowerCase() : ZONE_COLORS[0].value;
  return { ...l, zones: [...l.zones, { id: newId(l.zones, 'zone'), name, x, y, w, h, color }] };
}

export function updateZone(l: MapLayout, id: string, patch: { name?: string; color?: string }): MapLayout {
  return {
    ...l,
    zones: l.zones.map((z) => {
      if (z.id !== id) return z;
      const name = patch.name !== undefined ? patch.name.trim().slice(0, MAP_LIMITS.maxZoneNameLength) || z.name : z.name;
      const color = patch.color && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color.toLowerCase() : z.color;
      return { ...z, name, color };
    }),
  };
}

export function moveZone(l: MapLayout, id: string, x: number, y: number): MapLayout {
  const z = l.zones.find((v) => v.id === id);
  if (!z) return l;
  const nx = Math.round(clamp(x, 0, l.cols - z.w));
  const ny = Math.round(clamp(y, 0, l.rows - z.h));
  if (nx === z.x && ny === z.y) return l;
  return { ...l, zones: l.zones.map((v) => (v.id === id ? { ...v, x: nx, y: ny } : v)) };
}

export function resizeZoneRect(
  l: Pick<MapLayout, 'cols' | 'rows'>,
  orig: Pick<MapZoneBox, 'x' | 'y' | 'w' | 'h'>,
  handle: ZoneHandle,
  gx: number,
  gy: number,
): { x: number; y: number; w: number; h: number } {
  const cx = clamp(Math.round(gx), 0, l.cols);
  const cy = clamp(Math.round(gy), 0, l.rows);
  let x1 = orig.x;
  let y1 = orig.y;
  let x2 = orig.x + orig.w;
  let y2 = orig.y + orig.h;
  if (handle.includes('w')) x1 = Math.min(cx, x2 - 1);
  if (handle.includes('e')) x2 = Math.max(cx, x1 + 1);
  if (handle.includes('n')) y1 = Math.min(cy, y2 - 1);
  if (handle.includes('s')) y2 = Math.max(cy, y1 + 1);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function resizeZone(l: MapLayout, id: string, rect: { x: number; y: number; w: number; h: number }): MapLayout {
  const z = l.zones.find((v) => v.id === id);
  if (!z) return l;
  const x = Math.round(clamp(rect.x, 0, l.cols - 1));
  const y = Math.round(clamp(rect.y, 0, l.rows - 1));
  const w = Math.round(clamp(rect.w, 1, l.cols - x));
  const h = Math.round(clamp(rect.h, 1, l.rows - y));
  if (x === z.x && y === z.y && w === z.w && h === z.h) return l;
  return { ...l, zones: l.zones.map((v) => (v.id === id ? { ...v, x, y, w, h } : v)) };
}

export function removeZone(l: MapLayout, id: string): MapLayout {
  return { ...l, zones: l.zones.filter((v) => v.id !== id) };
}

/** Name of the zone box containing grid cell (x, y), if any. */
export function zoneBoxAt(l: MapLayout, x: number, y: number): string | undefined {
  for (let i = l.zones.length - 1; i >= 0; i--) {
    const z = l.zones[i];
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.name;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Group selection, move & delete                                      */
/* ------------------------------------------------------------------ */

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

/** Edit-mode marquee selection: PCs intersecting rect, landmarks/labels inside rect, zones fully contained in rect. */
export function itemsInRect(l: MapLayout, ax: number, ay: number, bx: number, by: number): EditItemRef[] {
  const [x0, x1] = ax < bx ? [ax, bx] : [bx, ax];
  const [y0, y1] = ay < by ? [ay, by] : [by, ay];
  const out: EditItemRef[] = [];
  for (const p of l.pcs) {
    if (p.x + 1 > x0 && p.x < x1 && p.y + 1 > y0 && p.y < y1) out.push({ type: 'pc', id: p.id });
  }
  for (const m of l.landmarks) {
    if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) out.push({ type: 'landmark', id: m.id });
  }
  for (const t of l.labels) {
    if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) out.push({ type: 'label', id: t.id });
  }
  for (const z of l.zones) {
    if (z.x >= x0 && z.x + z.w <= x1 && z.y >= y0 && z.y + z.h <= y1) out.push({ type: 'zone', id: z.id });
  }
  return out;
}

/** Computes snapped & grid-clamped delta for moving a group of selected elements together. */
export function clampGroupDelta(l: MapLayout, items: EditItemRef[], rawDx: number, rawDy: number): { dx: number; dy: number } {
  if (!items.length) return { dx: 0, dy: 0 };
  const integerSnap = items.some((i) => i.type === 'pc' || i.type === 'zone');
  let dx = integerSnap ? Math.round(rawDx) : Math.round(rawDx * 2) / 2;
  let dy = integerSnap ? Math.round(rawDy) : Math.round(rawDy * 2) / 2;

  let minDx = -Infinity;
  let maxDx = Infinity;
  let minDy = -Infinity;
  let maxDy = Infinity;

  for (const item of items) {
    if (item.type === 'pc') {
      const p = l.pcs.find((v) => v.id === item.id);
      if (!p) continue;
      minDx = Math.max(minDx, -p.x);
      maxDx = Math.min(maxDx, l.cols - 1 - p.x);
      minDy = Math.max(minDy, -p.y);
      maxDy = Math.min(maxDy, l.rows - 1 - p.y);
    } else if (item.type === 'zone') {
      const z = l.zones.find((v) => v.id === item.id);
      if (!z) continue;
      minDx = Math.max(minDx, -z.x);
      maxDx = Math.min(maxDx, l.cols - z.w - z.x);
      minDy = Math.max(minDy, -z.y);
      maxDy = Math.min(maxDy, l.rows - z.h - z.y);
    } else if (item.type === 'landmark') {
      const m = l.landmarks.find((v) => v.id === item.id);
      if (!m) continue;
      minDx = Math.max(minDx, 0.5 - m.x);
      maxDx = Math.min(maxDx, l.cols - 0.5 - m.x);
      minDy = Math.max(minDy, 0.5 - m.y);
      maxDy = Math.min(maxDy, l.rows - 0.5 - m.y);
    } else if (item.type === 'label') {
      const t = l.labels.find((v) => v.id === item.id);
      if (!t) continue;
      minDx = Math.max(minDx, 0.5 - t.x);
      maxDx = Math.min(maxDx, l.cols - 0.5 - t.x);
      minDy = Math.max(minDy, 0.5 - t.y);
      maxDy = Math.min(maxDy, l.rows - 0.5 - t.y);
    }
  }

  if (minDx > maxDx) dx = 0;
  else dx = clamp(dx, integerSnap ? Math.ceil(minDx) : minDx, integerSnap ? Math.floor(maxDx) : maxDx);
  if (minDy > maxDy) dy = 0;
  else dy = clamp(dy, integerSnap ? Math.ceil(minDy) : minDy, integerSnap ? Math.floor(maxDy) : maxDy);

  return { dx, dy };
}

/** True when a group move would place a selected PC onto an unselected PC's cell. */
export function hasGroupPcConflict(l: MapLayout, items: EditItemRef[], dx: number, dy: number): boolean {
  if (items.length === 1 && items[0].type === 'pc') return false; // single PC swaps
  const selPcIds = new Set(items.filter((i): i is { type: 'pc'; id: number } => i.type === 'pc').map((i) => i.id));
  if (!selPcIds.size) return false;
  const occupied = new Set(l.pcs.filter((p) => !selPcIds.has(p.id)).map((p) => `${p.x},${p.y}`));
  for (const p of l.pcs) {
    if (!selPcIds.has(p.id)) continue;
    if (occupied.has(`${p.x + dx},${p.y + dy}`)) return true;
  }
  return false;
}

/** Moves all selected items together by (dx, dy). Single-PC drags keep swap-on-drop semantics. */
export function moveGroup(l: MapLayout, items: EditItemRef[], rawDx: number, rawDy: number): MapLayout {
  if (!items.length) return l;
  const { dx, dy } = clampGroupDelta(l, items, rawDx, rawDy);
  if (dx === 0 && dy === 0) return l;

  if (items.length === 1) {
    const it = items[0];
    if (it.type === 'pc') {
      const p = l.pcs.find((v) => v.id === it.id);
      return p ? movePc(l, it.id, p.x + dx, p.y + dy) : l;
    }
    if (it.type === 'landmark') {
      const m = l.landmarks.find((v) => v.id === it.id);
      return m ? moveLandmark(l, it.id, m.x + dx, m.y + dy) : l;
    }
    if (it.type === 'label') {
      const t = l.labels.find((v) => v.id === it.id);
      return t ? moveLabel(l, it.id, t.x + dx, t.y + dy) : l;
    }
    const z = l.zones.find((v) => v.id === it.id);
    return z ? moveZone(l, it.id, z.x + dx, z.y + dy) : l;
  }

  if (hasGroupPcConflict(l, items, dx, dy)) return l;

  const pcSet = new Set(items.filter((i): i is { type: 'pc'; id: number } => i.type === 'pc').map((i) => i.id));
  const lmSet = new Set(items.filter((i): i is { type: 'landmark'; id: string } => i.type === 'landmark').map((i) => i.id));
  const lblSet = new Set(items.filter((i): i is { type: 'label'; id: string } => i.type === 'label').map((i) => i.id));
  const zoneSet = new Set(items.filter((i): i is { type: 'zone'; id: string } => i.type === 'zone').map((i) => i.id));

  return {
    ...l,
    pcs: pcSet.size ? l.pcs.map((p) => (pcSet.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p)) : l.pcs,
    landmarks: lmSet.size ? l.landmarks.map((m) => (lmSet.has(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)) : l.landmarks,
    labels: lblSet.size ? l.labels.map((t) => (lblSet.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t)) : l.labels,
    zones: zoneSet.size ? l.zones.map((z) => (zoneSet.has(z.id) ? { ...z, x: z.x + dx, y: z.y + dy } : z)) : l.zones,
  };
}

/** Removes all selected items from the map layout in one operation. */
export function removeItems(l: MapLayout, items: EditItemRef[]): MapLayout {
  if (!items.length) return l;
  const pcSet = new Set(items.filter((i): i is { type: 'pc'; id: number } => i.type === 'pc').map((i) => i.id));
  const lmSet = new Set(items.filter((i): i is { type: 'landmark'; id: string } => i.type === 'landmark').map((i) => i.id));
  const lblSet = new Set(items.filter((i): i is { type: 'label'; id: string } => i.type === 'label').map((i) => i.id));
  const zoneSet = new Set(items.filter((i): i is { type: 'zone'; id: string } => i.type === 'zone').map((i) => i.id));

  return {
    ...l,
    pcs: pcSet.size ? l.pcs.filter((p) => !pcSet.has(p.id)) : l.pcs,
    landmarks: lmSet.size ? l.landmarks.filter((m) => !lmSet.has(m.id)) : l.landmarks,
    labels: lblSet.size ? l.labels.filter((t) => !lblSet.has(t.id)) : l.labels,
    zones: zoneSet.size ? l.zones.filter((z) => !zoneSet.has(z.id)) : l.zones,
  };
}

/** Zone for a new PC on an empty slot: enclosing zone box first, then nearest existing PC. */
export function zoneNear(l: MapLayout, zoneOf: (id: number) => string | undefined, id: number): string {
  const me = l.pcs.find((p) => p.id === id);
  if (me) {
    const box = zoneBoxAt(l, me.x, me.y);
    if (box) return box;
  }
  let best: { d: number; zone: string } | null = null;
  for (const p of l.pcs) {
    const zone = p.id === id ? undefined : zoneOf(p.id);
    if (!me || !zone) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (!best || d < best.d) best = { d, zone };
  }
  return best?.zone ?? 'Regular';
}

/** Zone suggestion for a grid cell (x, y) when creating a new PC directly on the map. */
export function zoneNearCell(l: MapLayout, zoneOf: (id: number) => string | undefined, x: number, y: number): string {
  const box = zoneBoxAt(l, x, y);
  if (box) return box;
  let best: { d: number; zone: string } | null = null;
  for (const p of l.pcs) {
    const zone = zoneOf(p.id);
    if (!zone) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (!best || d < best.d) best = { d, zone };
  }
  return best?.zone ?? 'Regular';
}
