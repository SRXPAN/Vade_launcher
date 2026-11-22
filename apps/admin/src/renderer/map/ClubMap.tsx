/**
 * Interactive club map of the "Комп'ютери" tab: every PC at its real table, coloured by status.
 * View mode: hover card, click / right click menu, Ctrl+click and Shift/Ctrl+frame selection, pan and zoom.
 * Edit mode: group select & drag, zone boxes with resize handles, walls, landmarks (rotatable), PC/slot placement,
 * full Undo/Redo, and JSON export/import.
 */
import {
  ArrowBigDown,
  BrickWall,
  ChevronDown,
  ConciergeBell,
  CupSoda,
  DoorOpen,
  Download,
  Eraser,
  FireExtinguisher,
  Gamepad2,
  LoaderCircle,
  Maximize,
  Minus,
  Monitor,
  Move,
  PencilRuler,
  Plus,
  PlusSquare,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Server,
  Sofa,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Undo2,
  Upload,
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
import {
  defaultMapLayout,
  LANDMARK_KINDS,
  LANDMARK_TITLES,
  MAP_LIMITS,
  type LandmarkKind,
  type MapLabel,
  type MapLayout,
  type MapWall,
  type MapZoneBox,
  type Rotation,
} from '../../shared/mapLayout';
import { api, errorText } from '../api';
import { ConfirmDialog, Menu, useToast } from '../ui';
import { EmptySlotDialog, ExistingPcDialog, LabelDialog, ZoneBoxDialog } from './MapDialogs';
import {
  addLabel,
  addLandmark,
  addWall,
  addZone,
  clamp,
  clampGroupDelta,
  hasGroupPcConflict,
  itemKey,
  itemsInRect,
  moveGroup,
  nextFreeSlotId,
  parseItemKey,
  pcAt,
  pcsInRect,
  placePc,
  removeItems,
  removeLabel,
  removeLandmark,
  removePc,
  removeWall,
  removeZone,
  replaceSlotId,
  resizeGrid,
  resizeZone,
  resizeZoneRect,
  rotateLandmark,
  rotateLandmarks,
  snapCell,
  snapCorner,
  snapHalf,
  updateLabel,
  updateZone,
  wallTo,
  zoneNear,
  zoneNearCell,
  type EditItemRef,
  type ZoneHandle,
} from './mapEdit';
import { CELL, LabelGlyph, LandmarkGlyph, PcGlyph, ZoneBoxGlyph } from './MapGlyphs';
import { EditContextMenu, Floating, PcMenu, PcTooltip, type Anchor } from './MapPopups';
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
  onAddPc: (id: number, zone: string, onCreated?: (pc: PcRecord) => void) => void;
  onSteamLogin: (ids: number[]) => void;
  onUpdateAgent: (ids: number[]) => void;
}

type Tool = 'move' | 'wall' | 'erase';
type Placing =
  | { type: 'pc'; id: number }
  | { type: 'new-pc' }
  | { type: 'slot'; id: number }
  | { type: 'landmark'; kind: LandmarkKind; rot: Rotation }
  | { type: 'label'; text: string; zone?: string }
  | { type: 'zone'; name: string; color: string };

type Point = { x: number; y: number };

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; tx0: number; ty0: number; moved: boolean }
  | { kind: 'press'; id: number; sx: number; sy: number; ctrl: boolean; menuWasOpen: boolean }
  | { kind: 'band'; a: Point; mode: SelectMode }
  | { kind: 'edit-band'; a: Point; sx: number; sy: number; add: boolean; moved: boolean }
  | {
      kind: 'group-drag';
      items: EditItemRef[];
      anchorGrid: Point;
      sx: number;
      sy: number;
      moved: boolean;
      clickedKey: string;
      wasMultiSelected: boolean;
    }
  | { kind: 'zone-resize'; id: string; orig: MapZoneBox; handle: ZoneHandle }
  | { kind: 'zone-draw'; start: Point; name: string; color: string; sx: number; sy: number; moved: boolean }
  | { kind: 'wall'; start: Point };

interface Live {
  band?: { a: Point; b: Point };
  groupDrag?: { items: EditItemRef[]; dx: number; dy: number; conflict: boolean };
  zoneResize?: { id: string; rect: { x: number; y: number; w: number; h: number } };
  zoneDraw?: { x: number; y: number; w: number; h: number; name: string; color: string };
  wall?: MapWall;
  cursor?: Point;
}

interface Hit {
  pc?: number;
  landmark?: string;
  label?: string;
  wall?: number;
  zone?: string;
  zoneHandle?: ZoneHandle;
}

type DialogState =
  | 'reset'
  | 'discard'
  | 'existing-pc'
  | 'empty-slot'
  | 'label'
  | 'zone'
  | { kind: 'bind-slot'; slotId: number; inEdit: boolean }
  | { kind: 'edit-label'; label: MapLabel }
  | { kind: 'edit-zone'; zone: MapZoneBox }
  | null;

interface HistoryState {
  past: MapLayout[];
  future: MapLayout[];
}

const MIN_K = 0.35;
const MAX_K = 3;
const PAD = { side: 24, bottom: 56, top: 52, topEdit: 118 };

const LANDMARK_ICON: Record<LandmarkKind, ReactNode> = {
  entrance: <ArrowBigDown size={15} />,
  exit: <DoorOpen size={15} />,
  reception: <ConciergeBell size={15} />,
  wc: <span className="wc-mini">WC</span>,
  bar: <CupSoda size={15} />,
  sofa: <Sofa size={15} />,
  console: <Gamepad2 size={15} />,
  server: <Server size={15} />,
  extinguisher: <FireExtinguisher size={15} />,
};

const TOOL_HINT: Record<Tool, string> = {
  move: 'Клік / рамка / Ctrl+клік — вибір групи · перетягуйте разом · R — поворот орієнтира · Delete — прибрати · ПКМ — меню · Пробіл/СКМ — рух карти',
  wall: 'Тягніть від вузла сітки до вузла: стіна малюється горизонтально або вертикально.',
  erase: 'Клікніть по стіні, зоні, орієнтиру, підпису або ПК, щоб прибрати з карти (ПК залишиться в pcs.json).',
};

function hitOf(target: EventTarget | null): Hit {
  const el = (target as Element | null)?.closest?.(
    '[data-zone-handle],[data-pc],[data-landmark],[data-label],[data-wall],[data-zone]',
  ) as SVGElement | null;
  if (!el) return {};
  const d = el.dataset;
  if (d.zoneHandle && d.zone) return { zone: d.zone, zoneHandle: d.zoneHandle as ZoneHandle };
  if (d.pc) return { pc: Number(d.pc) };
  if (d.landmark) return { landmark: d.landmark };
  if (d.label) return { label: d.label };
  if (d.wall) return { wall: Number(d.wall) };
  if (d.zone) return { zone: d.zone };
  return {};
}

function itemOf(hit: Hit): EditItemRef | null {
  if (hit.pc != null) return { type: 'pc', id: hit.pc };
  if (hit.landmark) return { type: 'landmark', id: hit.landmark };
  if (hit.label) return { type: 'label', id: hit.label };
  if (hit.zone) return { type: 'zone', id: hit.zone };
  return null;
}

function zoneRectFromDrag(l: Pick<MapLayout, 'cols' | 'rows'>, a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  const c1 = snapCorner(l, a.x, a.y);
  const c2 = snapCorner(l, b.x, b.y);
  const x = Math.min(c1.x, c2.x);
  const y = Math.min(c1.y, c2.y);
  const w = Math.max(1, Math.min(l.cols - x, Math.abs(c2.x - c1.x) || 1));
  const h = Math.max(1, Math.min(l.rows - y, Math.abs(c2.y - c1.y) || 1));
  return { x: Math.min(x, l.cols - 1), y: Math.min(y, l.rows - 1), w, h };
}

export function ClubMap(props: Props) {
  const { pcs, runtimes, settings, selected, visible, filterActive, runStates, latestAgentVersion } = props;
  const toast = useToast();
  const [saved, setSaved] = useState<MapLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MapLayout | null>(null);
  const [hist, setHist] = useState<HistoryState>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>('move');
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [editSel, setEditSel] = useState<Set<string>>(new Set());
  const [spaceDown, setSpaceDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [vp, setVp] = useState({ k: 1, tx: 0, ty: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState<Live>({});
  const [hover, setHover] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [editMenu, setEditMenu] = useState<{ item: EditItemRef; anchor: Anchor } | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const editMenuRef = useRef<HTMLDivElement | null>(null);
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
  const histRef = useRef(hist);
  histRef.current = hist;
  const editSelRef = useRef(editSel);
  editSelRef.current = editSel;
  const placingRef = useRef(placing);
  placingRef.current = placing;
  const spaceRef = useRef(spaceDown);
  spaceRef.current = spaceDown;

  useEffect(() => {
    api.getMapLayout().then(setSaved, (e) => toast('error', `Карта клубу: ${errorText(e)}`));
  }, [toast]);

  const byId = useMemo(() => new Map(pcs.map((p) => [p.id, p])), [pcs]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  const unplacedPcs = useMemo(
    () => (layout ? pcs.filter((p) => !layout.pcs.some((s) => s.id === p.id)) : []),
    [pcs, layout],
  );
  const unplaced = useMemo(() => unplacedPcs.map((p) => p.id), [unplacedPcs]);

  /** Validated EditItemRef list currently selected in edit mode. */
  const selectedItems = useMemo(() => {
    if (!editing || !draft || editSel.size === 0) return [];
    const out: EditItemRef[] = [];
    for (const k of editSel) {
      const ref = parseItemKey(k);
      if (!ref) continue;
      if (ref.type === 'pc' && draft.pcs.some((p) => p.id === ref.id)) out.push(ref);
      else if (ref.type === 'landmark' && draft.landmarks.some((m) => m.id === ref.id)) out.push(ref);
      else if (ref.type === 'label' && draft.labels.some((t) => t.id === ref.id)) out.push(ref);
      else if (ref.type === 'zone' && draft.zones.some((z) => z.id === ref.id)) out.push(ref);
    }
    return out;
  }, [editing, draft, editSel]);
  const selectedItemsRef = useRef(selectedItems);
  selectedItemsRef.current = selectedItems;

  const selectedLandmarkIds = useMemo(
    () => selectedItems.filter((i): i is { type: 'landmark'; id: string } => i.type === 'landmark').map((i) => i.id),
    [selectedItems],
  );
  const selectedLandmarkIdsRef = useRef(selectedLandmarkIds);
  selectedLandmarkIdsRef.current = selectedLandmarkIds;

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
      setEditMenu(null);
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

  const clientToAnchor = (clientX: number, clientY: number): Anchor => {
    const r = boxRef.current!.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    return { left: x, top: y, right: x, bottom: y };
  };

  /* ---------------- hover / menus ---------------- */

  const scheduleHover = (id: number | null) => {
    if (id === hoverPending.current) return;
    hoverPending.current = id;
    window.clearTimeout(hoverTimer.current);
    if (id == null) setHover(null);
    else hoverTimer.current = window.setTimeout(() => setHover(id), hover == null ? 160 : 40);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (menu == null && editMenu == null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menu != null && !menuRef.current?.contains(target)) setMenu(null);
      if (editMenu != null && !editMenuRef.current?.contains(target)) setEditMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setEditMenu(null);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, editMenu]);

  /* ---------------- editing & undo/redo ---------------- */

  const commit = useCallback((next: MapLayout) => {
    const cur = draftRef.current;
    if (!cur || next === cur) return;
    draftRef.current = next;
    const nextHist = { past: [...histRef.current.past.slice(-99), cur], future: [] };
    histRef.current = nextHist;
    setHist(nextHist);
    setDraft(next);
  }, []);

  const undo = useCallback(() => {
    const cur = draftRef.current;
    const h = histRef.current;
    if (!cur || !h.past.length) return;
    const prev = h.past[h.past.length - 1];
    const nextHist = { past: h.past.slice(0, -1), future: [...h.future.slice(-99), cur] };
    histRef.current = nextHist;
    draftRef.current = prev;
    setHist(nextHist);
    setDraft(prev);
    setEditMenu(null);
  }, []);

  const redo = useCallback(() => {
    const cur = draftRef.current;
    const h = histRef.current;
    if (!cur || !h.future.length) return;
    const next = h.future[h.future.length - 1];
    const nextHist = { past: [...h.past.slice(-99), cur], future: h.future.slice(0, -1) };
    histRef.current = nextHist;
    draftRef.current = next;
    setHist(nextHist);
    setDraft(next);
    setEditMenu(null);
  }, []);

  const rotateSelected = useCallback(() => {
    const p = placingRef.current;
    if (p?.type === 'landmark') {
      setPlacing({ ...p, rot: ((p.rot + 90) % 360) as Rotation });
      return;
    }
    const ids = selectedLandmarkIdsRef.current;
    if (!ids.length || !draftRef.current) return;
    commit(rotateLandmarks(draftRef.current, ids));
  }, [commit]);

  const deleteSelected = useCallback(() => {
    const items = selectedItemsRef.current;
    if (!items.length || !draftRef.current) return;
    const removedDbPcs = items.filter((i) => i.type === 'pc' && byIdRef.current.has(i.id)).length;
    commit(removeItems(draftRef.current, items));
    setEditSel(new Set());
    setEditMenu(null);
    if (removedDbPcs > 0) {
      toast('info', removedDbPcs === 1 ? 'ПК прибрано з карти (залишився у pcs.json)' : `Прибрано з карти ${removedDbPcs} ПК (залишилися у pcs.json)`);
    }
  }, [commit, toast]);

  useEffect(() => {
    if (!editing) {
      setSpaceDown(false);
      return;
    }
    const isInput = (t: EventTarget | null) =>
      !!document.querySelector('.backdrop') || !!(t as Element | null)?.closest?.('input, textarea, select');

    const onKeyDown = (e: KeyboardEvent) => {
      if (isInput(e.target)) return;
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      if (e.key === 'Escape') {
        if (placingRef.current) setPlacing(null);
        else if (gesture.current) {
          gesture.current = null;
          setLive({});
        } else if (editSelRef.current.size) setEditSel(new Set());
        setEditMenu(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      // e.code works identically under Ukrainian and English keyboard layouts
      if (mod && e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((mod && e.code === 'KeyY') || (mod && e.shiftKey && e.code === 'KeyZ')) {
        e.preventDefault();
        redo();
        return;
      }
      if (!mod && !e.altKey && e.code === 'KeyR') {
        if (placingRef.current?.type === 'landmark' || selectedLandmarkIdsRef.current.length > 0) {
          e.preventDefault();
          rotateSelected();
        }
        return;
      }
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedItemsRef.current.length > 0) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (!mod && !e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const items = selectedItemsRef.current;
        const cur = draftRef.current;
        if (!items.length || !cur) return;
        e.preventDefault();
        const step = items.some((i) => i.type === 'pc' || i.type === 'zone') ? 1 : 0.5;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const next = moveGroup(cur, items, dx, dy);
        if (next !== cur) commit(next);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    const onBlur = () => setSpaceDown(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [editing, undo, redo, rotateSelected, deleteSelected, commit]);

  const startEdit = () => {
    if (!saved) return;
    draftRef.current = saved;
    histRef.current = { past: [], future: [] };
    setDraft(saved);
    setHist({ past: [], future: [] });
    setTool('move');
    setPlacing(null);
    setEditSel(new Set());
    setMenu(null);
    setEditMenu(null);
    setHover(null);
    autoFit.current = true;
    setEditing(true);
  };

  const stopEdit = () => {
    setEditing(false);
    setDraft(null);
    histRef.current = { past: [], future: [] };
    setHist({ past: [], future: [] });
    setPlacing(null);
    setEditSel(new Set());
    setEditMenu(null);
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

  const exportMap = async () => {
    const l = layoutRef.current;
    if (!l) return;
    try {
      const r = await api.exportMapLayout(l);
      if (r.ok && r.path) toast('ok', `Карту експортовано:\n${r.path}`);
      else if (r.error) toast('error', r.error);
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const importMap = async () => {
    try {
      const r = await api.importMapLayout();
      if (!r.ok) {
        if (r.error) toast('error', r.error);
        return;
      }
      if (r.layout && draftRef.current) {
        commit(r.layout);
        setEditSel(new Set());
        autoFit.current = true;
        toast('ok', 'Карту імпортовано. Перевірте схему й натисніть «Зберегти».');
      }
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const createPcOnCell = (cx: number, cy: number) => {
    const l = draftRef.current;
    if (!l) return;
    const occupied = pcAt(l, cx, cy);
    if (occupied != null) {
      toast('warn', `Клітинка зайнята місцем №${occupied}`);
      return;
    }
    const suggestedId = nextFreeSlotId(l, pcs.map((p) => p.id));
    const suggestedZone = zoneNearCell(l, (pid) => byIdRef.current.get(pid)?.zone, cx, cy);
    props.onAddPc(suggestedId, suggestedZone, (created) => {
      const cur = draftRef.current;
      if (!cur) return;
      if (cur.pcs.some((s) => s.id === created.id)) {
        // User picked an ID that already had an empty reserve slot on the map
        toast('info', `ПК №${created.id} прив’язано до існуючого слоту на карті`);
        return;
      }
      const next = placePc(cur, created.id, cx, cy);
      if (next !== cur) {
        commit(next);
        setEditSel(new Set([itemKey({ type: 'pc', id: created.id })]));
      }
    });
  };

  const createPcOnSlot = (slotId: number, inEdit: boolean) => {
    const l = inEdit ? draftRef.current : saved;
    if (!l) return;
    const suggestedZone = zoneNear(l, (pid) => byIdRef.current.get(pid)?.zone, slotId);
    props.onAddPc(slotId, suggestedZone, (created) => {
      if (created.id === slotId) return;
      // If user changed the number in PcEditor, update the slot's number so it stays linked at that cell
      if (inEdit) {
        const cur = draftRef.current;
        if (cur) commit(replaceSlotId(cur, slotId, created.id));
      } else if (saved) {
        const next = replaceSlotId(saved, slotId, created.id);
        if (next !== saved) void api.saveMapLayout(next).then(setSaved, (e) => toast('error', errorText(e)));
      }
    });
  };

  const bindPcToSlot = async (slotId: number, pc: PcRecord, inEdit: boolean) => {
    if (inEdit) {
      const cur = draftRef.current;
      if (!cur) return;
      const next = replaceSlotId(cur, slotId, pc.id);
      if (next === cur) {
        toast('warn', `ПК №${pc.id} уже розміщено на карті`);
        return;
      }
      commit(next);
      setEditSel(new Set([itemKey({ type: 'pc', id: pc.id })]));
      toast('ok', `ПК №${pc.id} прив’язано до місця (натисніть «Зберегти»)`);
    } else if (saved) {
      const next = replaceSlotId(saved, slotId, pc.id);
      if (next === saved) {
        toast('warn', `ПК №${pc.id} уже розміщено на карті`);
        return;
      }
      try {
        setSaved(await api.saveMapLayout(next));
        toast('ok', `ПК №${pc.id} прив’язано до місця на карті`);
      } catch (e) {
        toast('error', errorText(e));
      }
    }
  };

  const placeAt = (g: Point) => {
    const l = draftRef.current;
    if (!l || !placing) return;
    if (placing.type === 'pc' || placing.type === 'slot') {
      const c = snapCell(l, g.x, g.y);
      const next = placePc(l, placing.id, c.x, c.y);
      if (next === l) {
        toast('warn', `Клітинка зайнята місцем №${pcAt(l, c.x, c.y)}`);
        return;
      }
      commit(next);
      setEditSel(new Set([itemKey({ type: 'pc', id: placing.id })]));
      setPlacing(null);
      return;
    }
    if (placing.type === 'new-pc') {
      const c = snapCell(l, g.x, g.y);
      setPlacing(null);
      createPcOnCell(c.x, c.y);
      return;
    }
    if (placing.type === 'landmark') {
      const h = snapHalf(l, g.x, g.y);
      const next = addLandmark(l, placing.kind, h.x, h.y, placing.rot);
      const added = next.landmarks[next.landmarks.length - 1];
      commit(next);
      if (added) setEditSel(new Set([itemKey({ type: 'landmark', id: added.id })]));
      setPlacing(null);
      return;
    }
    if (placing.type === 'label') {
      const h = snapHalf(l, g.x, g.y);
      const next = addLabel(l, placing.text, placing.zone, h.x, h.y);
      const added = next.labels[next.labels.length - 1];
      commit(next);
      if (added) setEditSel(new Set([itemKey({ type: 'label', id: added.id })]));
      setPlacing(null);
    }
  };

  const erase = (hit: Hit): boolean => {
    const l = draftRef.current;
    if (!l) return false;
    if (hit.wall != null) commit(removeWall(l, hit.wall));
    else if (hit.landmark) commit(removeLandmark(l, hit.landmark));
    else if (hit.label) commit(removeLabel(l, hit.label));
    else if (hit.zone) commit(removeZone(l, hit.zone));
    else if (hit.pc != null) {
      const existsInDb = byId.has(hit.pc);
      commit(removePc(l, hit.pc));
      if (existsInDb) toast('info', `ПК №${hit.pc} прибрано з карти (залишився у pcs.json)`);
    } else return false;
    return true;
  };

  /* ---------------- pointer ---------------- */

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const l = layoutRef.current;
    if (!l || e.button === 2) return;
    scheduleHover(null);
    setEditMenu(null);
    const svg = e.currentTarget;
    const capture = () => svg.setPointerCapture(e.pointerId);
    const pan = () => {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx0: vpRef.current.tx, ty0: vpRef.current.ty, moved: false };
      capture();
    };
    if (e.button === 1 || (editing && spaceRef.current)) {
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
      if (placing.type === 'zone') {
        gesture.current = { kind: 'zone-draw', start: g, name: placing.name, color: placing.color, sx: e.clientX, sy: e.clientY, moved: false };
        capture();
      } else {
        placeAt(g);
      }
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

    // Move tool: check zone resize handle first
    if (hit.zone && hit.zoneHandle) {
      const orig = l.zones.find((z) => z.id === hit.zone);
      if (orig) {
        gesture.current = { kind: 'zone-resize', id: orig.id, orig, handle: hit.zoneHandle };
        setLive({ zoneResize: { id: orig.id, rect: { x: orig.x, y: orig.y, w: orig.w, h: orig.h } } });
        capture();
        return;
      }
    }

    const item = itemOf(hit);
    if (item) {
      const key = itemKey(item);
      if (e.ctrlKey || e.metaKey) {
        setEditSel((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      const alreadySelected = editSelRef.current.has(key);
      const dragItems = alreadySelected ? selectedItemsRef.current : [item];
      if (!alreadySelected) setEditSel(new Set([key]));
      gesture.current = {
        kind: 'group-drag',
        items: dragItems,
        anchorGrid: g,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        clickedKey: key,
        wasMultiSelected: alreadySelected && dragItems.length > 1,
      };
      capture();
      return;
    }

    // Left-drag on empty floor in move tool draws a marquee selection
    gesture.current = { kind: 'edit-band', a: g, sx: e.clientX, sy: e.clientY, add: e.ctrlKey || e.metaKey, moved: false };
    capture();
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
        setEditMenu(null);
        const { tx0, ty0 } = gs;
        setVp((v) => ({ ...v, tx: tx0 + dx, ty: ty0 + dy }));
        return;
      }
      case 'band':
        setLive({ band: { a: gs.a, b: toGrid(e) } });
        return;
      case 'edit-band': {
        if (!gs.moved && Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < 5) return;
        gs.moved = true;
        setLive({ band: { a: gs.a, b: toGrid(e) } });
        return;
      }
      case 'group-drag': {
        if (!gs.moved && Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < 4) return;
        gs.moved = true;
        const g = toGrid(e);
        const { dx, dy } = clampGroupDelta(l, gs.items, g.x - gs.anchorGrid.x, g.y - gs.anchorGrid.y);
        const conflict = hasGroupPcConflict(l, gs.items, dx, dy);
        setLive({ groupDrag: { items: gs.items, dx, dy, conflict } });
        return;
      }
      case 'zone-resize': {
        const g = toGrid(e);
        setLive({ zoneResize: { id: gs.id, rect: resizeZoneRect(l, gs.orig, gs.handle, g.x, g.y) } });
        return;
      }
      case 'zone-draw': {
        if (!gs.moved && Math.hypot(e.clientX - gs.sx, e.clientY - gs.sy) < 6) return;
        gs.moved = true;
        const rect = zoneRectFromDrag(l, gs.start, toGrid(e));
        setLive({ zoneDraw: { ...rect, name: gs.name, color: gs.color } });
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
      case 'edit-band': {
        if (!gs.moved) {
          if (!gs.add) setEditSel(new Set());
          return;
        }
        const picked = itemsInRect(l, gs.a.x, gs.a.y, g.x, g.y).map(itemKey);
        setEditSel((prev) => (gs.add ? new Set([...prev, ...picked]) : new Set(picked)));
        return;
      }
      case 'group-drag': {
        if (!gs.moved) {
          if (gs.wasMultiSelected) setEditSel(new Set([gs.clickedKey]));
          return;
        }
        const cur = draftRef.current;
        if (!cur) return;
        const { dx, dy } = clampGroupDelta(cur, gs.items, g.x - gs.anchorGrid.x, g.y - gs.anchorGrid.y);
        if (dx === 0 && dy === 0) return;
        if (hasGroupPcConflict(cur, gs.items, dx, dy)) {
          toast('warn', 'Не можна перемістити групу: клітинка зайнята іншим ПК');
          return;
        }
        commit(moveGroup(cur, gs.items, dx, dy));
        return;
      }
      case 'zone-resize': {
        const cur = draftRef.current;
        if (cur) commit(resizeZone(cur, gs.id, resizeZoneRect(cur, gs.orig, gs.handle, g.x, g.y)));
        return;
      }
      case 'zone-draw': {
        const cur = draftRef.current;
        if (!cur) return;
        const rect = gs.moved
          ? zoneRectFromDrag(cur, gs.start, g)
          : (() => {
              const c = snapCell(cur, gs.start.x, gs.start.y);
              const w = Math.min(4, cur.cols - c.x);
              const h = Math.min(3, cur.rows - c.y);
              return { x: c.x, y: c.y, w: Math.max(1, w), h: Math.max(1, h) };
            })();
        const next = addZone(cur, { name: gs.name, color: gs.color, ...rect });
        const added = next.zones[next.zones.length - 1];
        commit(next);
        if (added) setEditSel(new Set([itemKey({ type: 'zone', id: added.id })]));
        setPlacing(null);
        return;
      }
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
      if (placing) {
        setPlacing(null);
        return;
      }
      const item = itemOf(hit);
      if (item && boxRef.current) {
        setEditSel(new Set([itemKey(item)]));
        setEditMenu({ item, anchor: clientToAnchor(e.clientX, e.clientY) });
      }
      return;
    }
    if (hit.pc != null) {
      scheduleHover(null);
      setMenu(hit.pc);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!editing || tool !== 'move' || placing) return;
    const hit = hitOf(e.target);
    const cur = draftRef.current;
    if (!cur) return;
    if (hit.landmark) {
      commit(rotateLandmark(cur, hit.landmark));
      return;
    }
    if (hit.label) {
      const lbl = cur.labels.find((t) => t.id === hit.label);
      if (lbl) setDialog({ kind: 'edit-label', label: lbl });
      return;
    }
    if (hit.zone) {
      const z = cur.zones.find((v) => v.id === hit.zone);
      if (z) setDialog({ kind: 'edit-zone', zone: z });
    }
  };

  /* ---------------- render helpers ---------------- */

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
  const groupDrag = live.groupDrag;
  const draggedKeys = useMemo(() => new Set(groupDrag ? groupDrag.items.map(itemKey) : []), [groupDrag]);
  const showTip = !editing && menu == null && hover != null && !gesture.current;
  const tipAnchor = showTip ? anchorOf(hover) : null;
  const menuAnchor = menu != null ? anchorOf(menu) : null;
  const cursorCell = live.cursor && layout ? snapCell(layout, live.cursor.x, live.cursor.y) : null;
  const cursorHalf = live.cursor && layout ? snapHalf(layout, live.cursor.x, live.cursor.y) : null;
  const cursorCorner = live.cursor && layout ? snapCorner(layout, live.cursor.x, live.cursor.y) : null;
  const newPcGhostId = layout ? nextFreeSlotId(layout, pcs.map((p) => p.id)) : 1;

  const placingHint = (() => {
    if (!placing) return TOOL_HINT[tool];
    switch (placing.type) {
      case 'pc':
        return `Клікніть на вільну клітинку, щоб поставити ПК №${placing.id}. Esc — скасувати.`;
      case 'new-pc':
        return 'Клікніть на порожню клітинку, щоб створити новий ПК і одразу розмістити його там. Esc — скасувати.';
      case 'slot':
        return `Клікніть на вільну клітинку, щоб поставити резервний слот №${placing.id}. Esc — скасувати.`;
      case 'landmark':
        return `Клікніть на карті, щоб поставити «${LANDMARK_TITLES[placing.kind]}» (клавіша R — поворот на 90°). Esc — скасувати.`;
      case 'label':
        return `Клікніть на карті, щоб поставити підпис «${placing.text}». Esc — скасувати.`;
      case 'zone':
        return `Протягніть прямокутник зони «${placing.name}» по сітці (або клікніть раз для 4×3). Esc — скасувати.`;
    }
  })();

  const mapClasses = [
    'club-map',
    editing ? `editing tool-${tool}` : '',
    placing ? 'placing' : '',
    placing?.type === 'zone' ? 'placing-zone' : '',
    spaceDown ? 'panning' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={boxRef} className={mapClasses}>
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

            {/* Zone boxes (below walls and PCs) */}
            {layout.zones.map((z) => {
              const key = itemKey({ type: 'zone', id: z.id });
              const isDragged = draggedKeys.has(key);
              const resized = live.zoneResize?.id === z.id ? { ...z, ...live.zoneResize.rect } : z;
              const isSel = editing && editSel.has(key);
              return (
                <g key={z.id} className={isDragged ? 'drag-src' : undefined}>
                  <ZoneBoxGlyph z={resized} editSelected={isSel} showHandles={isSel && tool === 'move' && !placing && !groupDrag} />
                </g>
              );
            })}

            {layout.walls.map((w, i) => (
              <g key={`${w.x1},${w.y1},${w.x2},${w.y2}`} className="map-wall" data-wall={i}>
                <line className="wall-hit" x1={w.x1 * CELL} y1={w.y1 * CELL} x2={w.x2 * CELL} y2={w.y2 * CELL} />
                <line className="wall-line" x1={w.x1 * CELL} y1={w.y1 * CELL} x2={w.x2 * CELL} y2={w.y2 * CELL} />
              </g>
            ))}

            {layout.labels.map((t) => {
              const key = itemKey({ type: 'label', id: t.id });
              if (draggedKeys.has(key)) {
                return (
                  <g key={t.id} className="drag-src">
                    <LabelGlyph t={t} />
                  </g>
                );
              }
              return <LabelGlyph key={t.id} t={t} editSelected={editing && editSel.has(key)} />;
            })}

            {layout.landmarks.map((m) => {
              const key = itemKey({ type: 'landmark', id: m.id });
              if (draggedKeys.has(key)) {
                return (
                  <g key={m.id} className="drag-src">
                    <LandmarkGlyph m={m} />
                  </g>
                );
              }
              return <LandmarkGlyph key={m.id} m={m} editSelected={editing && editSel.has(key)} />;
            })}

            {layout.pcs.map((s) => {
              const key = itemKey({ type: 'pc', id: s.id });
              const isDragged = draggedKeys.has(key);
              const exists = byId.has(s.id);
              return (
                <g key={s.id} className={isDragged ? 'drag-src' : undefined}>
                  <PcGlyph
                    id={s.id}
                    x={s.x}
                    y={s.y}
                    {...pcProps(s.id)}
                    selected={!editing && selected.has(s.id)}
                    editSelected={editing && editSel.has(key)}
                    dim={!editing && filterActive && (!exists || !visible.has(s.id))}
                  />
                </g>
              );
            })}

            {/* Group drag ghost previews */}
            {groupDrag &&
              groupDrag.items.map((item) => {
                if (item.type === 'zone') {
                  const z = layout.zones.find((v) => v.id === item.id);
                  return z ? <ZoneBoxGlyph key={itemKey(item)} z={{ ...z, x: z.x + groupDrag.dx, y: z.y + groupDrag.dy }} ghost /> : null;
                }
                if (item.type === 'pc') {
                  const p = layout.pcs.find((v) => v.id === item.id);
                  if (!p) return null;
                  const nx = p.x + groupDrag.dx;
                  const ny = p.y + groupDrag.dy;
                  return (
                    <g key={itemKey(item)}>
                      <rect
                        className={`map-target${groupDrag.conflict ? ' conflict' : ''}`}
                        x={nx * CELL + 1}
                        y={ny * CELL + 1}
                        width={CELL - 2}
                        height={CELL - 2}
                        rx={9}
                      />
                      <PcGlyph id={p.id} x={nx} y={ny} {...pcProps(p.id)} selected={false} dim={false} ghost conflict={groupDrag.conflict} />
                    </g>
                  );
                }
                if (item.type === 'landmark') {
                  const m = layout.landmarks.find((v) => v.id === item.id);
                  return m ? <LandmarkGlyph key={itemKey(item)} m={{ ...m, x: m.x + groupDrag.dx, y: m.y + groupDrag.dy }} ghost /> : null;
                }
                const t = layout.labels.find((v) => v.id === item.id);
                return t ? <LabelGlyph key={itemKey(item)} t={{ ...t, x: t.x + groupDrag.dx, y: t.y + groupDrag.dy }} ghost /> : null;
              })}

            {/* Zone drawing preview */}
            {live.zoneDraw && <ZoneBoxGlyph z={{ id: 'ghost-zone', ...live.zoneDraw }} ghost />}

            {/* Wall preview */}
            {live.wall && (
              <line className="wall-preview" x1={live.wall.x1 * CELL} y1={live.wall.y1 * CELL} x2={live.wall.x2 * CELL} y2={live.wall.y2 * CELL} />
            )}
            {editing && tool === 'wall' && !placing && cursorCorner && <circle className="wall-node" cx={cursorCorner.x * CELL} cy={cursorCorner.y * CELL} r={5} />}

            {/* Placement ghosts */}
            {placing?.type === 'pc' && cursorCell && (
              <>
                <rect className="map-target" x={cursorCell.x * CELL + 1} y={cursorCell.y * CELL + 1} width={CELL - 2} height={CELL - 2} rx={9} />
                <PcGlyph id={placing.id} x={cursorCell.x} y={cursorCell.y} {...pcProps(placing.id)} selected={false} dim={false} ghost />
              </>
            )}
            {placing?.type === 'new-pc' && cursorCell && (
              <>
                <rect className="map-target" x={cursorCell.x * CELL + 1} y={cursorCell.y * CELL + 1} width={CELL - 2} height={CELL - 2} rx={9} />
                <PcGlyph id={newPcGhostId} x={cursorCell.x} y={cursorCell.y} tone="online" disk="ok" progress={null} selected={false} dim={false} ghost />
              </>
            )}
            {placing?.type === 'slot' && cursorCell && (
              <>
                <rect className="map-target" x={cursorCell.x * CELL + 1} y={cursorCell.y * CELL + 1} width={CELL - 2} height={CELL - 2} rx={9} />
                <PcGlyph id={placing.id} x={cursorCell.x} y={cursorCell.y} tone="empty" disk="ok" progress={null} selected={false} dim={false} ghost />
              </>
            )}
            {placing?.type === 'landmark' && cursorHalf && <LandmarkGlyph m={{ id: 'ghost', kind: placing.kind, rot: placing.rot, ...cursorHalf }} ghost />}
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
                <div className="meb-menu">
                  <div className="meb-menu-head">Комп’ютери</div>
                  <button
                    onClick={() => {
                      close();
                      setDialog('existing-pc');
                    }}
                  >
                    <Monitor size={15} />
                    <span>Додати існуючий ПК на карту…{unplaced.length > 0 ? ` (${unplaced.length})` : ''}</span>
                  </button>
                  <button
                    onClick={() => {
                      close();
                      setTool('move');
                      setPlacing({ type: 'new-pc' });
                    }}
                  >
                    <PlusSquare size={15} />
                    <span>Створити новий ПК тут</span>
                  </button>
                  <button
                    onClick={() => {
                      close();
                      setDialog('empty-slot');
                    }}
                  >
                    <SquareDashed size={15} />
                    <span>Додати порожній слот (резерв)…</span>
                  </button>
                  <hr />
                  <div className="meb-menu-head">Зони</div>
                  <button
                    onClick={() => {
                      close();
                      setDialog('zone');
                    }}
                  >
                    <Square size={15} />
                    <span>Рамка зони…</span>
                  </button>
                  <button
                    onClick={() => {
                      close();
                      setDialog('label');
                    }}
                  >
                    <Type size={15} />
                    <span>Підпис зони…</span>
                  </button>
                  <hr />
                  <div className="meb-menu-head">Орієнтири</div>
                  {LANDMARK_KINDS.map((k) => (
                    <button
                      key={k}
                      onClick={() => {
                        close();
                        setTool('move');
                        setPlacing({ type: 'landmark', kind: k, rot: 0 });
                      }}
                    >
                      {LANDMARK_ICON[k]} <span>{LANDMARK_TITLES[k]}</span>
                    </button>
                  ))}
                </div>
              )}
            </Menu>

            <span className="meb-size">
              Сітка
              <GridNumber value={draft.cols} min={MAP_LIMITS.minCols} max={MAP_LIMITS.maxCols} onCommit={(v) => commit(resizeGrid(draft, v, draft.rows))} />×
              <GridNumber value={draft.rows} min={MAP_LIMITS.minRows} max={MAP_LIMITS.maxRows} onCommit={(v) => commit(resizeGrid(draft, draft.cols, v))} />
            </span>

            <span className="divider-v" />

            <button className="icon-btn" disabled={!hist.past.length} onClick={undo} title="Назад (Ctrl+Z)">
              <Undo2 size={15} />
            </button>
            <button className="icon-btn" disabled={!hist.future.length} onClick={redo} title="Повторити (Ctrl+Y / Ctrl+Shift+Z)">
              <Redo2 size={15} />
            </button>
            <button
              className="icon-btn"
              disabled={selectedLandmarkIds.length === 0 && placing?.type !== 'landmark'}
              onClick={rotateSelected}
              title="Повернути вибраний орієнтир на 90° (R)"
            >
              <RotateCw size={15} />
            </button>
            <button
              className="icon-btn"
              disabled={selectedItems.length === 0}
              onClick={deleteSelected}
              title="Прибрати вибране з карти (Delete)"
            >
              <Trash2 size={15} />
            </button>

            <span className="divider-v" />

            <button className="btn small ghost" onClick={() => void exportMap()} title="Експортувати схему у JSON (map_layout.json)">
              <Download size={14} /> Експорт
            </button>
            <button className="btn small ghost" onClick={() => void importMap()} title="Імпортувати схему з JSON-файлу">
              <Upload size={14} /> Імпорт
            </button>

            <span className="spacer" />

            <button className="btn small ghost" onClick={() => setDialog('reset')}>
              <RotateCcw size={14} /> Скинути
            </button>
            <button className="btn small" onClick={() => (dirty ? setDialog('discard') : stopEdit())}>
              Скасувати
            </button>
            <button className="btn small primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Зберегти
            </button>
          </div>
          <div className="meb-row meb-hint">
            {selectedItems.length > 0 && (
              <span className="meb-sel-pill">Вибрано: {selectedItems.length}</span>
            )}
            <span>{placingHint}</span>
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
            unplacedCount={unplacedPcs.length}
            onClose={() => setMenu(null)}
            onAction={props.onAction}
            onLogs={props.onLogs}
            onEdit={props.onEdit}
            onSteam={props.onSteamLogin}
            onUpdateAgent={props.onUpdateAgent}
            onToggleSelect={(id) => props.onSelect([id], 'toggle')}
            onAdd={(id) => createPcOnSlot(id, false)}
            onBindSlot={(slotId) => setDialog({ kind: 'bind-slot', slotId, inEdit: false })}
          />
        </Floating>
      )}

      {editing && editMenu && draft && (
        <Floating anchor={editMenu.anchor} bounds={size} className="map-menu compact" innerRef={editMenuRef}>
          <EditContextMenu
            item={editMenu.item}
            pc={editMenu.item.type === 'pc' ? byId.get(editMenu.item.id) : undefined}
            landmark={editMenu.item.type === 'landmark' ? draft.landmarks.find((m) => m.id === editMenu.item.id) : undefined}
            label={editMenu.item.type === 'label' ? draft.labels.find((t) => t.id === editMenu.item.id) : undefined}
            zone={editMenu.item.type === 'zone' ? draft.zones.find((z) => z.id === editMenu.item.id) : undefined}
            unplacedCount={unplacedPcs.length}
            onClose={() => setEditMenu(null)}
            onEditPc={props.onEdit}
            onCreatePcOnSlot={(slotId) => createPcOnSlot(slotId, true)}
            onBindSlot={(slotId) => setDialog({ kind: 'bind-slot', slotId, inEdit: true })}
            onRemovePcFromMap={(id) => {
              const existsInDb = byId.has(id);
              commit(removePc(draft, id));
              setEditSel(new Set());
              if (existsInDb) toast('info', `ПК №${id} прибрано з карти (залишився у pcs.json)`);
            }}
            onRotateLandmark={(id) => commit(rotateLandmark(draft, id))}
            onRemoveLandmark={(id) => {
              commit(removeLandmark(draft, id));
              setEditSel(new Set());
            }}
            onEditLabel={(lbl) => setDialog({ kind: 'edit-label', label: lbl })}
            onRemoveLabel={(id) => {
              commit(removeLabel(draft, id));
              setEditSel(new Set());
            }}
            onEditZone={(z) => setDialog({ kind: 'edit-zone', zone: z })}
            onRemoveZone={(id) => {
              commit(removeZone(draft, id));
              setEditSel(new Set());
            }}
          />
        </Floating>
      )}

      {dialog === 'reset' && (
        <ConfirmDialog
          title="Скинути до стандартної карти?"
          text="Розташування ПК, стіни, зони, орієнтири й підписи буде замінено стандартною схемою залу. Зміни запишуться у файл після «Зберегти»; до того їх можна скасувати."
          confirmLabel="Скинути"
          onConfirm={() => {
            if (draftRef.current) {
              commit(defaultMapLayout());
              setEditSel(new Set());
            }
          }}
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
      {dialog === 'existing-pc' && (
        <ExistingPcDialog
          title="Додати існуючий ПК на карту"
          hint="Оберіть ПК із pcs.json, якого ще немає на карті, а потім клікніть на вільну клітинку сітки."
          pcs={unplacedPcs}
          onPick={(pc) => {
            setDialog(null);
            setTool('move');
            setPlacing({ type: 'pc', id: pc.id });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'empty-slot' && draft && (
        <EmptySlotDialog
          suggestedId={nextFreeSlotId(draft, pcs.map((p) => p.id))}
          usedOnMap={new Set(draft.pcs.map((p) => p.id))}
          existingPcIds={new Set(pcs.map((p) => p.id))}
          onDone={(id) => {
            setDialog(null);
            setTool('move');
            setPlacing({ type: 'slot', id });
          }}
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
      {dialog === 'zone' && (
        <ZoneBoxDialog
          onClose={() => setDialog(null)}
          onDone={(name, color) => {
            setTool('move');
            setPlacing({ type: 'zone', name, color });
            setDialog(null);
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'bind-slot' && (
        <ExistingPcDialog
          title={`Прив’язати ПК до слоту №${dialog.slotId}`}
          hint="Оберіть існуючий ПК із бази, який ще не розміщено на карті. Його буде поставлено на місце цього слоту."
          pcs={unplacedPcs}
          onPick={(pc) => {
            const { slotId, inEdit } = dialog;
            setDialog(null);
            void bindPcToSlot(slotId, pc, inEdit);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'edit-label' && draft && (
        <LabelDialog
          initial={{ text: dialog.label.text, zone: dialog.label.zone }}
          onClose={() => setDialog(null)}
          onDone={(text, zone) => {
            commit(updateLabel(draft, dialog.label.id, text, zone));
            setDialog(null);
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'edit-zone' && draft && (
        <ZoneBoxDialog
          initial={{ name: dialog.zone.name, color: dialog.zone.color }}
          onClose={() => setDialog(null)}
          onDone={(name, color) => {
            commit(updateZone(draft, dialog.zone.id, { name, color }));
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
