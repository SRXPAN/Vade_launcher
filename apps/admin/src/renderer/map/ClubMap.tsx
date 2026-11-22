/**
 * Interactive club map of the "Комп'ютери" tab: every PC at its real table, coloured by status.
 * View mode: hover card, click / right click menu, Ctrl+click and Shift/Ctrl+frame selection, pan and zoom.
 * Edit mode: drag slots and landmarks, draw / erase walls, save to map_layout.json.
 */
import {
  ArrowBigDown,
  BrickWall,
  ChevronDown,
  ConciergeBell,
  Eraser,
  FireExtinguisher,
  LoaderCircle,
  Maximize,
  Minus,
  Move,
  PencilRuler,
  Plus,
  RotateCcw,
  Save,
  Type,
  Undo2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { compareVersions, type AppSettings, type PcRecord, type PcRuntime } from '@vade/protocol';
import type { PcAction } from '../../shared/api';
import { defaultMapLayout, LANDMARK_KINDS, LANDMARK_TITLES, MAP_LIMITS, type LandmarkKind, type MapLayout, type MapWall } from '../../shared/mapLayout';
import { api, errorText } from '../api';
import { ConfirmDialog, Menu, Modal, useToast } from '../ui';
import {
  addLabel,
  addLandmark,
  addWall,
  clamp,
  movePc,
  moveLabel,
  moveLandmark,
  pcAt,
  pcsInRect,
  placePc,
  removeLabel,
  removeLandmark,
  removePc,
  removeWall,
  resizeGrid,
  rotateLandmark,
  snapCell,
  snapCorner,
  snapHalf,
  wallTo,
  zoneNear,
} from './mapEdit';
import { CELL, LabelGlyph, LandmarkGlyph, PcGlyph } from './MapGlyphs';
import { Floating, PcMenu, PcTooltip, type Anchor } from './MapPopups';
import { diskAlert, jobProgress, LEGEND, mapTone, TONE_COLOR } from './mapStatus';

export type SelectMode = 'toggle' | 'add' | 'replace';

interface Props {
  pcs: PcRecord[];
  runtimes: Record<number, PcRuntime>;
  settings: AppSettings;
  selected: Set<number>;
  /** PCs that pass the zone / search filter */
  visible: Set<number>;
  filterActive: boolean;
  runStates: Record<number, string>;
  latestAgentVersion: string | null;
  onSelect: (ids: number[], mode: SelectMode) => void;
  onAction: (action: PcAction, ids: number[]) => void;
  onLogs: (id: number) => void;
  onEdit: (pc: PcRecord) => void;
  onAddPc: (id: number, zone: string) => void;
  onSteamLogin: (ids: number[]) => void;
  onUpdateAgent: (ids: number[]) => void;
}

type Tool = 'move' | 'wall' | 'erase';
type Placing = { type: 'pc'; id: number } | { type: 'landmark'; kind: LandmarkKind } | { type: 'label'; text: string; zone?: string };
type ItemRef = { type: 'pc'; id: number } | { type: 'landmark'; id: string } | { type: 'label'; id: string };
type Point = { x: number; y: number };

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; tx0: number; ty0: number; moved: boolean }
  | { kind: 'press'; id: number; sx: number; sy: number; ctrl: boolean; menuWasOpen: boolean }
  | { kind: 'band'; a: Point; mode: SelectMode }
  | { kind: 'drag'; item: ItemRef; off: Point; sx: number; sy: number; moved: boolean }
  | { kind: 'wall'; start: Point };

interface Live {
  band?: { a: Point; b: Point };
  drag?: { item: ItemRef; at: Point };
  wall?: MapWall;
  cursor?: Point;
}

interface Hit {
  pc?: number;
  landmark?: string;
  label?: string;
  wall?: number;
}

const MIN_K = 0.35;
const MAX_K = 3;
const PAD = { side: 24, bottom: 56, top: 52, topEdit: 112 };

const LANDMARK_ICON: Record<LandmarkKind, ReactNode> = {
  entrance: <ArrowBigDown size={15} />,
  reception: <ConciergeBell size={15} />,
  wc: <span className="wc-mini">WC</span>,
  extinguisher: <FireExtinguisher size={15} />,
};

const TOOL_HINT: Record<Tool, string> = {
  move: 'Перетягуйте ПК, орієнтири й підписи — вони прилипають до сітки. ПК на місце іншого = обмін місцями. Подвійний клік по входу повертає стрілку.',
  wall: 'Тягніть від вузла сітки до вузла: стіна малюється горизонтально або вертикально.',
  erase: 'Клікніть по стіні, орієнтиру, підпису або ПК, щоб прибрати з карти (ПК залишиться в базі).',
};

function hitOf(target: EventTarget | null): Hit {
  const el = (target as Element | null)?.closest?.('[data-pc],[data-landmark],[data-label],[data-wall]') as SVGElement | null;
  if (!el) return {};
  const d = el.dataset;
  if (d.pc) return { pc: Number(d.pc) };
  if (d.landmark) return { landmark: d.landmark };
  if (d.label) return { label: d.label };
  if (d.wall) return { wall: Number(d.wall) };
  return {};
}

function itemOf(hit: Hit): ItemRef | null {
  if (hit.pc != null) return { type: 'pc', id: hit.pc };
  if (hit.landmark) return { type: 'landmark', id: hit.landmark };
  if (hit.label) return { type: 'label', id: hit.label };
  return null;
}

/** Top-left cell of a PC, centre of a landmark / label. */
function itemPos(l: MapLayout, item: ItemRef): Point | null {
  if (item.type === 'pc') return l.pcs.find((p) => p.id === item.id) ?? null;
  if (item.type === 'landmark') return l.landmarks.find((m) => m.id === item.id) ?? null;
  return l.labels.find((t) => t.id === item.id) ?? null;
}

function dragTarget(l: MapLayout, item: ItemRef, p: Point): Point {
  if (item.type === 'pc') return { x: clamp(Math.round(p.x), 0, l.cols - 1), y: clamp(Math.round(p.y), 0, l.rows - 1) };
  return snapHalf(l, p.x, p.y);
}

function applyDrag(l: MapLayout, item: ItemRef, at: Point): MapLayout {
  if (item.type === 'pc') return movePc(l, item.id, at.x, at.y);
  if (item.type === 'landmark') return moveLandmark(l, item.id, at.x, at.y);
  return moveLabel(l, item.id, at.x, at.y);
}

const sameItem = (a: ItemRef | undefined, type: ItemRef['type'], id: number | string) => !!a && a.type === type && a.id === id;

export function ClubMap(props: Props) {
  const { pcs, runtimes, settings, selected, visible, filterActive, runStates, latestAgentVersion } = props;
  const toast = useToast();
  const [saved, setSaved] = useState<MapLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MapLayout | null>(null);
  const [history, setHistory] = useState<MapLayout[]>([]);
  const [tool, setTool] = useState<Tool>('move');
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'reset' | 'discard' | 'label' | null>(null);
  const [vp, setVp] = useState({ k: 1, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState<Live>({});
  const [hover, setHover] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const autoFit = useRef(true);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverPending = useRef<number | null>(null);

  const layout = editing ? draft : saved;
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    api.getMapLayout().then(setSaved, (e) => toast('error', `Карта клубу: ${errorText(e)}`));
  }, [toast]);

  /* ---------------- viewport ---------------- */

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  /** Fits the whole grid between the top overlay (hint / edit bar, which may wrap) and the legend. */
  const fit = useCallback(() => {
    const l = layoutRef.current;
    const box = boxRef.current;
    if (!l || !box || !box.clientWidth || !box.clientHeight) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const topBar = box.querySelector<HTMLElement>(editing ? '.map-editbar' : '.map-hint');
    const legend = box.querySelector<HTMLElement>('.map-legend');
    const top = topBar ? topBar.offsetTop + topBar.offsetHeight + 14 : editing ? PAD.topEdit : PAD.top;
    const bottom = legend ? h - legend.offsetTop + 12 : PAD.bottom;
    const W = l.cols * CELL;
    const H = l.rows * CELL;
    const k = clamp(Math.min((w - PAD.side * 2) / W, (h - top - bottom) / H), MIN_K, MAX_K);
    setVp({ k, tx: (w - W * k) / 2, ty: top + Math.max(0, (h - top - bottom - H * k) / 2) });
  }, [editing]);

  const hasLayout = !!layout;
  useLayoutEffect(() => {
    if (autoFit.current) fit();
  }, [fit, hasLayout, layout?.cols, layout?.rows, size.w, size.h]);

  const zoomAt = useCallback((factor: number, mx: number, my: number) => {
    autoFit.current = false;
    setVp((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const f = k / v.k;
      return { k, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f };
    });
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('.map-overlay, .map-menu')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setMenu(null);
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const toGrid = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = vpRef.current;
    return { x: (e.clientX - r.left - v.tx) / v.k / CELL, y: (e.clientY - r.top - v.ty) / v.k / CELL };
  };

  const anchorOf = (id: number): Anchor | null => {
    const s = layout?.pcs.find((p) => p.id === id);
    if (!s) return null;
    const c = CELL * vp.k;
    const left = vp.tx + s.x * c;
    const top = vp.ty + s.y * c;
    return { left, top, right: left + c, bottom: top + c };
  };

  /* ---------------- hover / menu ---------------- */

  const scheduleHover = (id: number | null) => {
    if (id === hoverPending.current) return;
    hoverPending.current = id;
    window.clearTimeout(hoverTimer.current);
    if (id == null) setHover(null);
    else hoverTimer.current = window.setTimeout(() => setHover(id), hover == null ? 160 : 40);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (menu == null) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /* ---------------- editing ---------------- */

  const commit = useCallback((next: MapLayout) => {
    const cur = draftRef.current;
    if (!cur || next === cur) return;
    draftRef.current = next;
    setHistory((h) => [...h.slice(-79), cur]);
    setDraft(next);
  }, []);

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    draftRef.current = prev;
    setDraft(prev);
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.backdrop') || (e.target as Element).closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') {
        setPlacing(null);
        gesture.current = null;
        setLive({});
      }
      // e.code: Ctrl+Z also works with the Ukrainian layout (key = "я")
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  const startEdit = () => {
    if (!saved) return;
    draftRef.current = saved;
    setDraft(saved);
    setHistory([]);
    setTool('move');
    setPlacing(null);
    setMenu(null);
    setHover(null);
    autoFit.current = true;
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setDraft(null);
    setHistory([]);
    setPlacing(null);
    setLive({});
    autoFit.current = true;
  };
  const dirty = useMemo(() => editing && !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved), [editing, draft, saved]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      setSaved(await api.saveMapLayout(draft));
      stopEdit();
      toast('ok', 'Карту клубу збережено');
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const placeAt = (g: Point) => {
    const l = draftRef.current;
    if (!l || !placing) return;
    if (placing.type === 'pc') {
      const c = snapCell(l, g.x, g.y);
      const next = placePc(l, placing.id, c.x, c.y);
      if (next === l) {
        toast('warn', `Клітинка зайнята ПК №${pcAt(l, c.x, c.y)}`);
        return;
      }
      commit(next);
    } else {
      const h = snapHalf(l, g.x, g.y);
      commit(placing.type === 'landmark' ? addLandmark(l, placing.kind, h.x, h.y) : addLabel(l, placing.text, placing.zone, h.x, h.y));
    }
    setPlacing(null);
  };

  const erase = (hit: Hit): boolean => {
    const l = draftRef.current;
    if (!l) return false;
    if (hit.wall != null) commit(removeWall(l, hit.wall));
    else if (hit.landmark) commit(removeLandmark(l, hit.landmark));
    else if (hit.label) commit(removeLabel(l, hit.label));
    else if (hit.pc != null) commit(removePc(l, hit.pc));
    else return false;
    return true;
  };

  /* ---------------- pointer ---------------- */

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const l = layoutRef.current;
    if (!l || e.button === 2) return;
    scheduleHover(null);
    const svg = e.currentTarget;
    const capture = () => svg.setPointerCapture(e.pointerId);
    const pan = () => {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx0: vpRef.current.tx, ty0: vpRef.current.ty, moved: false };
      capture();
    };
    if (e.button === 1) {
      e.preventDefault();
      pan();
      return;
    }
    if (e.button !== 0) return;
    const g = toGrid(e);
    const hit = hitOf(e.target);

    if (!editing) {
      if (hit.pc != null) {
        gesture.current = { kind: 'press', id: hit.pc, sx: e.clientX, sy: e.clientY, ctrl: e.ctrlKey || e.metaKey, menuWasOpen: menu === hit.pc };
        capture();
      } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
        gesture.current = { kind: 'band', a: g, mode: e.ctrlKey || e.metaKey ? 'add' : 'replace' };
        setLive({ band: { a: g, b: g } });
        capture();
      } else pan();
      return;
    }

    if (placing) {
      placeAt(g);
      return;
    }
    if (tool === 'wall') {
      const start = snapCorner(l, g.x, g.y);
      gesture.current = { kind: 'wall', start };
      setLive({ wall: { x1: start.x, y1: start.y, x2: start.x, y2: start.y } });
      capture();
      return;
    }
    if (tool === 'erase') {
      if (!erase(hit)) pan();
      return;
    }
    const item = itemOf(hit);
    const pos = item && itemPos(l, item);
    if (item && pos) {
      gesture.current = { kind: 'drag', item, off: { x: g.x - pos.x, y: g.y - pos.y }, sx: e.clientX, sy: e.clientY, moved: false };
      capture();
    } else pan();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const l = layoutRef.current;
    if (!l) return;
    let gs = gesture.current;
    if (!gs) {
      if (editing) {
        if (placing || tool === 'wall') setLive({ cursor: toGrid(e) });
      } else scheduleHover(hitOf(e.target).pc ?? null);
      return;
    }
    if (gs.kind === 'press') {
      if (Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < 5) return;
      // dragging from a PC pans the map like dragging the floor
      gs = gesture.current = { kind: 'pan', sx: gs.sx, sy: gs.sy, tx0: vpRef.current.tx, ty0: vpRef.current.ty, moved: false };
    }
    switch (gs.kind) {
      case 'pan': {
        const dx = e.clientX - gs.sx;
        const dy = e.clientY - gs.sy;
        if (!gs.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        gs.moved = true;
        autoFit.current = false;
        setMenu(null);
        const { tx0, ty0 } = gs;
        setVp((v) => ({ ...v, tx: tx0 + dx, ty: ty0 + dy }));
        return;
      }
      case 'band':
        setLive({ band: { a: gs.a, b: toGrid(e) } });
        return;
      case 'drag': {
        if (!gs.moved && Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < 4) return;
        gs.moved = true;
        const g = toGrid(e);
        setLive({ drag: { item: gs.item, at: dragTarget(l, gs.item, { x: g.x - gs.off.x, y: g.y - gs.off.y }) } });
        return;
      }
      case 'wall': {
        const g = toGrid(e);
        setLive({ wall: wallTo(l, gs.start, g.x, g.y), cursor: g });
        return;
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const gs = gesture.current;
    gesture.current = null;
    const l = layoutRef.current;
    if (!gs || !l) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setLive({});
    const g = toGrid(e);
    switch (gs.kind) {
      case 'press':
        if (gs.ctrl) {
          if (pcs.some((p) => p.id === gs.id)) props.onSelect([gs.id], 'toggle');
        } else if (!gs.menuWasOpen) setMenu(gs.id);
        return;
      case 'band': {
        const ids = pcsInRect(l, gs.a.x, gs.a.y, g.x, g.y).filter((id) => visible.has(id));
        props.onSelect(ids, gs.mode);
        return;
      }
      case 'drag':
        if (gs.moved && draftRef.current) commit(applyDrag(draftRef.current, gs.item, dragTarget(l, gs.item, { x: g.x - gs.off.x, y: g.y - gs.off.y })));
        return;
      case 'wall':
        if (draftRef.current) commit(addWall(draftRef.current, wallTo(l, gs.start, g.x, g.y)));
        return;
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setLive({});
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    const hit = hitOf(e.target);
    if (editing) {
      if (hit.landmark && draftRef.current) commit(rotateLandmark(draftRef.current, hit.landmark));
      return;
    }
    if (hit.pc != null) {
      scheduleHover(null);
      setMenu(hit.pc);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const hit = hitOf(e.target);
    if (editing && tool === 'move' && hit.landmark && draftRef.current) commit(rotateLandmark(draftRef.current, hit.landmark));
  };

  /* ---------------- render ---------------- */

  const byId = useMemo(() => new Map(pcs.map((p) => [p.id, p])), [pcs]);
  const unplaced = useMemo(() => (layout ? pcs.filter((p) => !layout.pcs.some((s) => s.id === p.id)).map((p) => p.id) : []), [pcs, layout]);
  const outdated = (id: number) => {
    const v = runtimes[id]?.info?.version;
    return !!v && !!latestAgentVersion && compareVersions(v, latestAgentVersion) < 0;
  };
  const pcProps = (id: number) => {
    const pc = byId.get(id);
    const rt = runtimes[id];
    return {
      tone: mapTone(rt, !!pc),
      disk: pc ? diskAlert(rt, settings.alerts) : ('ok' as const),
      progress: pc ? jobProgress(rt) : null,
    };
  };

  const W = (layout?.cols ?? 0) * CELL;
  const H = (layout?.rows ?? 0) * CELL;
  const drag = live.drag;
  const showTip = !editing && menu == null && hover != null && !gesture.current;
  const tipAnchor = showTip ? anchorOf(hover) : null;
  const menuAnchor = menu != null ? anchorOf(menu) : null;
  const cursorCell = live.cursor && layout ? snapCell(layout, live.cursor.x, live.cursor.y) : null;
  const cursorHalf = live.cursor && layout ? snapHalf(layout, live.cursor.x, live.cursor.y) : null;
  const cursorCorner = live.cursor && layout ? snapCorner(layout, live.cursor.x, live.cursor.y) : null;

  return (
    <div ref={boxRef} className={`club-map${editing ? ` editing tool-${tool}` : ''}${placing ? ' placing' : ''}`}>
      {!layout ? (
        <div className="map-loading">Завантаження карти…</div>
      ) : (
        <svg
          ref={svgRef}
          className="map-svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            scheduleHover(null);
            if (!gesture.current && live.cursor) setLive({});
          }}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
        >
          <defs>
            <pattern id="map-grid" width={CELL} height={CELL} patternUnits="userSpaceOnUse">
              <path className="grid-line" d={`M${CELL} 0H0V${CELL}`} fill="none" />
            </pattern>
          </defs>
          <g transform={`translate(${vp.tx} ${vp.ty}) scale(${vp.k})`}>
            <rect className="map-floor" x={0} y={0} width={W} height={H} />
            <rect x={0} y={0} width={W} height={H} fill="url(#map-grid)" pointerEvents="none" />

            {layout.walls.map((w, i) => (
              <g key={`${w.x1},${w.y1},${w.x2},${w.y2}`} className="map-wall" data-wall={i}>
                <line className="wall-hit" x1={w.x1 * CELL} y1={w.y1 * CELL} x2={w.x2 * CELL} y2={w.y2 * CELL} />
                <line className="wall-line" x1={w.x1 * CELL} y1={w.y1 * CELL} x2={w.x2 * CELL} y2={w.y2 * CELL} />
              </g>
            ))}

            {layout.labels.map((t) => (sameItem(drag?.item, 'label', t.id) ? null : <LabelGlyph key={t.id} t={t} />))}
            {layout.landmarks.map((m) => (sameItem(drag?.item, 'landmark', m.id) ? null : <LandmarkGlyph key={m.id} m={m} />))}

            {layout.pcs.map((s) => {
              const isDragged = sameItem(drag?.item, 'pc', s.id);
              const exists = byId.has(s.id);
              return (
                <g key={s.id} className={isDragged ? 'drag-src' : undefined}>
                  <PcGlyph
                    id={s.id}
                    x={s.x}
                    y={s.y}
                    {...pcProps(s.id)}
                    selected={!editing && selected.has(s.id)}
                    dim={!editing && filterActive && (!exists || !visible.has(s.id))}
                  />
                </g>
              );
            })}

            {drag && drag.item.type === 'pc' && (
              <>
                <rect className="map-target" x={drag.at.x * CELL + 1} y={drag.at.y * CELL + 1} width={CELL - 2} height={CELL - 2} rx={9} />
                <PcGlyph id={drag.item.id} x={drag.at.x} y={drag.at.y} {...pcProps(drag.item.id)} selected={false} dim={false} ghost />
              </>
            )}
            {drag && drag.item.type === 'landmark' && (() => {
              const m = layout.landmarks.find((v) => v.id === drag.item.id);
              return m ? <LandmarkGlyph m={{ ...m, ...drag.at }} ghost /> : null;
            })()}
            {drag && drag.item.type === 'label' && (() => {
              const t = layout.labels.find((v) => v.id === drag.item.id);
              return t ? <LabelGlyph t={{ ...t, ...drag.at }} ghost /> : null;
            })()}

            {live.wall && (
              <line className="wall-preview" x1={live.wall.x1 * CELL} y1={live.wall.y1 * CELL} x2={live.wall.x2 * CELL} y2={live.wall.y2 * CELL} />
            )}
            {editing && tool === 'wall' && !placing && cursorCorner && <circle className="wall-node" cx={cursorCorner.x * CELL} cy={cursorCorner.y * CELL} r={5} />}

            {placing?.type === 'pc' && cursorCell && (
              <PcGlyph id={placing.id} x={cursorCell.x} y={cursorCell.y} {...pcProps(placing.id)} selected={false} dim={false} ghost />
            )}
            {placing?.type === 'landmark' && cursorHalf && <LandmarkGlyph m={{ id: 'ghost', kind: placing.kind, rot: 0, ...cursorHalf }} ghost />}
            {placing?.type === 'label' && cursorHalf && <LabelGlyph t={{ id: 'ghost', text: placing.text, zone: placing.zone, ...cursorHalf }} ghost />}

            {live.band && (
              <rect
                className="map-band"
                x={Math.min(live.band.a.x, live.band.b.x) * CELL}
                y={Math.min(live.band.a.y, live.band.b.y) * CELL}
                width={Math.abs(live.band.b.x - live.band.a.x) * CELL}
                height={Math.abs(live.band.b.y - live.band.a.y) * CELL}
              />
            )}
          </g>
        </svg>
      )}

      {layout && !editing && (
        <>
          <div className="map-overlay map-hint">
            Клік або ПКМ — дії з ПК · Ctrl+клік — вибір · Shift/Ctrl + рамка — вибір групи · тягніть — рух карти · коліщатко — масштаб
            {unplaced.length > 0 && (
              <div className="map-unplaced">
                Не на карті: {unplaced.map((id) => `№${id}`).join(', ')}
                <button className="btn small" onClick={startEdit}>
                  Розмістити
                </button>
              </div>
            )}
          </div>
          <div className="map-overlay map-topright">
            <button className="btn small" onClick={startEdit}>
              <PencilRuler size={14} /> Редагувати карту
            </button>
          </div>
        </>
      )}

      {layout && editing && draft && (
        <div className="map-overlay map-editbar">
          <div className="meb-row">
            <div className="segmented">
              {(
                [
                  ['move', <Move size={14} key="i" />, 'Переміщення'],
                  ['wall', <BrickWall size={14} key="i" />, 'Стіни'],
                  ['erase', <Eraser size={14} key="i" />, 'Гумка'],
                ] as const
              ).map(([t, icon, label]) => (
                <button
                  key={t}
                  className={tool === t && !placing ? 'active' : ''}
                  onClick={() => {
                    setTool(t);
                    setPlacing(null);
                  }}
                >
                  {icon} {label}
                </button>
              ))}
            </div>
            <Menu
              down
              trigger={(open) => (
                <button className="btn small" onClick={open}>
                  <Plus size={14} /> Додати <ChevronDown size={13} />
                </button>
              )}
            >
              {(close) => (
                <>
                  {LANDMARK_KINDS.map((k) => (
                    <button
                      key={k}
                      onClick={() => {
                        close();
                        setTool('move');
                        setPlacing({ type: 'landmark', kind: k });
                      }}
                    >
                      {LANDMARK_ICON[k]} {LANDMARK_TITLES[k]}
                    </button>
                  ))}
                  <hr />
                  <button
                    onClick={() => {
                      close();
                      setDialog('label');
                    }}
                  >
                    <Type size={15} /> Підпис зони…
                  </button>
                </>
              )}
            </Menu>
            <span className="meb-size">
              Сітка
              <GridNumber value={draft.cols} min={MAP_LIMITS.minCols} max={MAP_LIMITS.maxCols} onCommit={(v) => commit(resizeGrid(draft, v, draft.rows))} />×
              <GridNumber value={draft.rows} min={MAP_LIMITS.minRows} max={MAP_LIMITS.maxRows} onCommit={(v) => commit(resizeGrid(draft, draft.cols, v))} />
            </span>
            <button className="btn small" disabled={!history.length} onClick={undo} title="Ctrl+Z">
              <Undo2 size={14} /> Назад
            </button>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setDialog('reset')}>
              <RotateCcw size={14} /> Скинути до стандартної
            </button>
            <button className="btn small" onClick={() => (dirty ? setDialog('discard') : stopEdit())}>
              Скасувати
            </button>
            <button className="btn small primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Зберегти
            </button>
          </div>
          <div className="meb-row meb-hint">
            <span>
              {placing
                ? `Клікніть на карті, щоб поставити ${placing.type === 'pc' ? `ПК №${placing.id}` : placing.type === 'label' ? `підпис «${placing.text}»` : LANDMARK_TITLES[placing.kind].toLowerCase()}. Esc — скасувати.`
                : TOOL_HINT[tool]}
            </span>
            {unplaced.length > 0 && (
              <span className="meb-unplaced">
                Не на карті:
                {unplaced.map((id) => (
                  <button
                    key={id}
                    className={`chip ${placing?.type === 'pc' && placing.id === id ? 'active' : ''}`}
                    title="Клікніть, потім клікніть на вільну клітинку карти"
                    onClick={() => {
                      setTool('move');
                      setPlacing({ type: 'pc', id });
                    }}
                  >
                    №{id}
                  </button>
                ))}
              </span>
            )}
          </div>
        </div>
      )}

      {layout && (
        <>
          <div className="map-overlay map-legend">
            {LEGEND.map((l) => (
              <span key={l.tone} className="lg-item">
                <i className={`lg-sw tone-${l.tone}`} style={l.tone === 'empty' ? undefined : { background: TONE_COLOR[l.tone] }} />
                {l.label}
              </span>
            ))}
            <span className="lg-item">
              <i className="lg-dot" /> Мало місця на диску
            </span>
          </div>
          <div className="map-overlay map-zoom">
            <button className="icon-btn" title="Збільшити" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}>
              <Plus size={16} />
            </button>
            <button className="icon-btn" title="Зменшити" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}>
              <Minus size={16} />
            </button>
            <button
              className="icon-btn"
              title="Вмістити все"
              onClick={() => {
                autoFit.current = true;
                fit();
              }}
            >
              <Maximize size={15} />
            </button>
            <span className="map-zoom-pct">{Math.round(vp.k * 100)}%</span>
          </div>
        </>
      )}

      {tipAnchor && hover != null && (
        <Floating anchor={tipAnchor} bounds={size} className="map-tip">
          <PcTooltip
            id={hover}
            pc={byId.get(hover)}
            rt={runtimes[hover]}
            tone={mapTone(runtimes[hover], byId.has(hover))}
            settings={settings}
            runState={runStates[hover] ?? null}
            latestAgentVersion={latestAgentVersion}
          />
        </Floating>
      )}

      {menuAnchor && menu != null && layout && (
        <Floating anchor={menuAnchor} bounds={size} className="map-menu" innerRef={menuRef}>
          <PcMenu
            id={menu}
            pc={byId.get(menu)}
            rt={runtimes[menu]}
            tone={mapTone(runtimes[menu], byId.has(menu))}
            selected={selected.has(menu)}
            outdated={outdated(menu)}
            onClose={() => setMenu(null)}
            onAction={props.onAction}
            onLogs={props.onLogs}
            onEdit={props.onEdit}
            onSteam={props.onSteamLogin}
            onUpdateAgent={props.onUpdateAgent}
            onToggleSelect={(id) => props.onSelect([id], 'toggle')}
            onAdd={(id) => props.onAddPc(id, zoneNear(layout, (pid) => byId.get(pid)?.zone, id))}
          />
        </Floating>
      )}

      {dialog === 'reset' && (
        <ConfirmDialog
          title="Скинути до стандартної карти?"
          text="Розташування ПК, стіни, орієнтири й підписи буде замінено стандартною схемою залу. Зміни запишуться у файл після «Зберегти»; до того їх можна скасувати."
          confirmLabel="Скинути"
          onConfirm={() => draftRef.current && commit(defaultMapLayout())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'discard' && (
        <ConfirmDialog
          title="Скасувати зміни карти?"
          text="Незбережені зміни розташування буде втрачено."
          confirmLabel="Скасувати зміни"
          danger
          onConfirm={stopEdit}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'label' && (
        <LabelDialog
          onClose={() => setDialog(null)}
          onDone={(text, zone) => {
            setTool('move');
            setPlacing({ type: 'label', text, zone });
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/** Number field that commits on Enter / blur, so typing "30" does not clamp at "3". */
function GridNumber({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    // the grid may refuse to shrink below placed elements: show the real size again
    setText(String(value));
  };
  return (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

function LabelDialog({ onClose, onDone }: { onClose: () => void; onDone: (text: string, zone: string | undefined) => void }) {
  const [text, setText] = useState('');
  const [zone, setZone] = useState('Regular');
  const ok = text.trim().length > 0;
  return (
    <Modal
      title="Підпис зони"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => onDone(text.trim(), zone || undefined)}>
            Поставити на карту
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label>Текст</label>
          <input
            className="input"
            autoFocus
            maxLength={MAP_LIMITS.maxLabelLength}
            value={text}
            placeholder="наприклад VIP"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ok && onDone(text.trim(), zone || undefined)}
          />
        </div>
        <div className="field">
          <label>Колір</label>
          <select className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="Regular">як Regular (сірий)</option>
            <option value="Stream">як Stream (фіолетовий)</option>
            <option value="">нейтральний</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
