/** SVG pieces of the club map. One grid cell = CELL world units. */
import {
  ArrowBigDown,
  ConciergeBell,
  CupSoda,
  DoorOpen,
  FireExtinguisher,
  Gamepad2,
  Server,
  Sofa,
} from 'lucide-react';
import { memo } from 'react';
import type { DiskLevel } from '@vade/protocol';
import type { LandmarkKind, MapLabel, MapLandmark, MapZoneBox } from '../../shared/mapLayout';
import type { ZoneHandle } from './mapEdit';
import { TONE_COLOR, type MapTone } from './mapStatus';

export const CELL = 48;

/** "#3ccf82", 0.2 -> "rgba(60, 207, 130, 0.2)" */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const DISK_COLOR: Record<DiskLevel, string> = { ok: 'transparent', warn: 'var(--warn)', crit: 'var(--err)' };

interface PcGlyphProps {
  id: number;
  x: number;
  y: number;
  tone: MapTone;
  selected: boolean;
  /** Selected in edit mode (group move / delete) */
  editSelected?: boolean;
  /** Filtered out by the zone / search filter */
  dim: boolean;
  disk: DiskLevel;
  /** 0..1 while SteamCMD downloads, otherwise null */
  progress: number | null;
  /** Rendered under the pointer while dragging / placing */
  ghost?: boolean;
  /** Highlight invalid drop cell during group drag */
  conflict?: boolean;
}

function PcGlyphImpl({ id, x, y, tone, selected, editSelected, dim, disk, progress, ghost, conflict }: PcGlyphProps) {
  const c = TONE_COLOR[tone];
  const empty = tone === 'empty';
  const muted = empty || tone === 'offline';
  const bodyFill = muted ? 'transparent' : `color-mix(in srgb, ${c} 15%, transparent)`;
  const bodyStroke = empty ? 'var(--map-pc-empty-stroke)' : `color-mix(in srgb, ${c} ${muted ? 60 : 82}%, transparent)`;

  return (
    <g
      className={`map-pc tone-${tone}${dim ? ' dim' : ''}${ghost ? ' ghost' : ''}${conflict ? ' conflict' : ''}${selected ? ' selected' : ''}${editSelected ? ' edit-sel' : ''}`}
      data-pc={ghost ? undefined : id}
      transform={`translate(${x * CELL} ${y * CELL})`}
    >
      <rect className="pc-hit" x={1} y={1} width={46} height={46} rx={9} />
      {(selected || editSelected) && <rect className="pc-sel" x={1.5} y={1.5} width={45} height={45} rx={9} />}
      <path d="M21 32h6l1.2 5h-8.4z" fill="var(--map-pc-stand)" />
      <rect x={15} y={37} width={18} height={3} rx={1.5} fill="var(--map-pc-stand)" />
      <rect x={6} y={5} width={36} height={27} rx={4} fill={muted ? 'var(--map-pc-screen-dim)' : 'var(--map-pc-screen)'} />
      <rect
        className="pc-body"
        x={6}
        y={5}
        width={36}
        height={27}
        rx={4}
        fill={bodyFill}
        stroke={bodyStroke}
        strokeWidth={1.6}
        strokeDasharray={empty ? '3 3' : undefined}
      />
      <text
        x={24}
        y={17.5}
        className="pc-num"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={id >= 100 ? 11 : 14}
        fill={muted ? 'var(--map-pc-num-dim)' : 'var(--map-pc-num)'}
      >
        {id}
      </text>
      {!empty &&
        (progress == null ? (
          <rect className="pc-strip" x={9} y={26} width={30} height={3.5} rx={1.75} fill={c} />
        ) : (
          <>
            <rect x={9} y={26} width={30} height={3.5} rx={1.75} fill={`color-mix(in srgb, ${c} 28%, transparent)`} />
            <rect className="pc-strip" x={9} y={26} width={Math.max(3.5, 30 * progress)} height={3.5} rx={1.75} fill={c} />
          </>
        ))}
      {disk !== 'ok' && <circle cx={40} cy={7} r={4.2} fill={DISK_COLOR[disk]} stroke="var(--map-floor)" strokeWidth={2} />}
      {selected && (
        <g className="pc-check">
          <circle cx={7.5} cy={7.5} r={6} />
          <path d="M4.8 7.6l1.9 1.9 3.6-3.7" />
        </g>
      )}
    </g>
  );
}

export const PcGlyph = memo(PcGlyphImpl);

const LANDMARK_COLOR: Record<LandmarkKind, string> = {
  entrance: 'var(--map-lm-icon)',
  exit: 'var(--ok)',
  reception: 'var(--map-lm-icon)',
  wc: 'var(--map-lm-icon)',
  bar: 'var(--warn)',
  sofa: 'var(--upd)',
  console: 'var(--sleep)',
  server: 'var(--accent)',
  extinguisher: 'var(--err)',
};

const LANDMARK_CAPTION: Record<LandmarkKind, string> = {
  entrance: 'ВХІД',
  exit: 'ВИХІД',
  reception: 'АДМІН',
  wc: '',
  bar: 'БАР',
  sofa: 'ДИВАН',
  console: 'PS5',
  server: 'СЕРВЕР',
  extinguisher: '',
};

export function LandmarkGlyph({ m, ghost, editSelected }: { m: MapLandmark; ghost?: boolean; editSelected?: boolean }) {
  const color = LANDMARK_COLOR[m.kind];
  const small = m.kind === 'extinguisher';
  const r = small ? 12 : 16;
  return (
    <g
      className={`map-landmark${ghost ? ' ghost' : ''}${editSelected ? ' edit-sel' : ''}`}
      data-landmark={ghost ? undefined : m.id}
      transform={`translate(${m.x * CELL} ${m.y * CELL})`}
    >
      <rect
        className="lm-box"
        x={-r}
        y={-r}
        width={r * 2}
        height={r * 2}
        rx={small ? 6 : 8}
        fill="var(--map-lm-bg)"
        stroke={`color-mix(in srgb, ${color} 45%, transparent)`}
        strokeWidth={1.3}
      />
      {m.kind === 'wc' ? (
        <text x={0} y={0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={800} fill={color} letterSpacing={0.5}>
          WC
        </text>
      ) : (
        <g transform={`rotate(${m.rot})`}>
          {m.kind === 'entrance' && <ArrowBigDown x={-11} y={-11} width={22} height={22} color={color} strokeWidth={2} />}
          {m.kind === 'exit' && <DoorOpen x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'reception' && <ConciergeBell x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'bar' && <CupSoda x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'sofa' && <Sofa x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'console' && <Gamepad2 x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'server' && <Server x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'extinguisher' && <FireExtinguisher x={-8} y={-8} width={16} height={16} color={color} strokeWidth={2} />}
        </g>
      )}
      {LANDMARK_CAPTION[m.kind] && (
        <text className="lm-caption" x={0} y={r + 11} textAnchor="middle" fontSize={9.5} fontWeight={700} letterSpacing={1.1}>
          {LANDMARK_CAPTION[m.kind]}
        </text>
      )}
    </g>
  );
}

const ZONE_LABEL_COLOR: Record<string, string> = {
  Stream: 'var(--map-label-stream)',
  Regular: 'var(--map-label-regular)',
};

export function LabelGlyph({ t, ghost, editSelected }: { t: MapLabel; ghost?: boolean; editSelected?: boolean }) {
  const width = t.text.length * 10.5 + 22;
  return (
    <g
      className={`map-label${ghost ? ' ghost' : ''}${editSelected ? ' edit-sel' : ''}`}
      data-label={ghost ? undefined : t.id}
      transform={`translate(${t.x * CELL} ${t.y * CELL})`}
    >
      <rect className="lbl-hit" x={-width / 2} y={-12} width={width} height={24} rx={6} />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={13}
        fontWeight={750}
        letterSpacing={3}
        fill={ZONE_LABEL_COLOR[t.zone ?? ''] ?? 'var(--map-label-default)'}
      >
        {t.text.toUpperCase()}
      </text>
    </g>
  );
}

const HANDLES: Array<{ h: ZoneHandle; fx: number; fy: number }> = [
  { h: 'nw', fx: 0, fy: 0 },
  { h: 'n', fx: 0.5, fy: 0 },
  { h: 'ne', fx: 1, fy: 0 },
  { h: 'e', fx: 1, fy: 0.5 },
  { h: 'se', fx: 1, fy: 1 },
  { h: 's', fx: 0.5, fy: 1 },
  { h: 'sw', fx: 0, fy: 1 },
  { h: 'w', fx: 0, fy: 0.5 },
];

export function ZoneBoxGlyph({
  z,
  ghost,
  editSelected,
  showHandles,
}: {
  z: MapZoneBox;
  ghost?: boolean;
  editSelected?: boolean;
  showHandles?: boolean;
}) {
  const px = z.x * CELL;
  const py = z.y * CELL;
  const pw = z.w * CELL;
  const ph = z.h * CELL;
  const badgeW = Math.min(pw - 12, Math.max(46, z.name.length * 8.2 + 18));

  return (
    <g className={`map-zone${ghost ? ' ghost' : ''}${editSelected ? ' edit-sel' : ''}`}>
      <rect
        className="zone-fill"
        x={px + 2}
        y={py + 2}
        width={Math.max(4, pw - 4)}
        height={Math.max(4, ph - 4)}
        rx={8}
        fill={alpha(z.color, 0.12)}
      />
      <rect
        className="zone-border"
        x={px + 2}
        y={py + 2}
        width={Math.max(4, pw - 4)}
        height={Math.max(4, ph - 4)}
        rx={8}
        fill="none"
        stroke={alpha(z.color, editSelected ? 0.95 : 0.58)}
        strokeWidth={editSelected ? 2.5 : 1.75}
        strokeDasharray={editSelected ? undefined : '7 4'}
      />
      {!ghost && (
        <rect
          className="zone-hit"
          data-zone={z.id}
          x={px + 2}
          y={py + 2}
          width={Math.max(4, pw - 4)}
          height={Math.max(4, ph - 4)}
          rx={8}
        />
      )}
      {badgeW >= 32 && (
        <g data-zone={ghost ? undefined : z.id} className="zone-badge-hit">
          <rect
            x={px + 8}
            y={py + 7}
            width={badgeW}
            height={20}
            rx={6}
            fill="var(--map-floor)"
            fillOpacity={0.86}
            stroke={alpha(z.color, 0.55)}
            strokeWidth={1}
          />
          <text
            x={px + 16}
            y={py + 17.5}
            dominantBaseline="central"
            fontSize={11}
            fontWeight={750}
            letterSpacing={0.9}
            fill={z.color}
            style={{ pointerEvents: 'none' }}
          >
            {z.name.toUpperCase()}
          </text>
        </g>
      )}
      {showHandles && !ghost &&
        HANDLES.map(({ h, fx, fy }) => (
          <rect
            key={h}
            className={`zone-handle zone-handle-${h}`}
            data-zone={z.id}
            data-zone-handle={h}
            x={px + fx * pw - 5}
            y={py + fy * ph - 5}
            width={10}
            height={10}
            rx={2.5}
          />
        ))}
    </g>
  );
}
