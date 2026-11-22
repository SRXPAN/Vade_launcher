/** SVG pieces of the club map. One grid cell = CELL world units. */
import { ArrowBigDown, ConciergeBell, FireExtinguisher } from 'lucide-react';
import { memo } from 'react';
import type { DiskLevel } from '@vade/protocol';
import type { MapLabel, MapLandmark } from '../../shared/mapLayout';
import { TONE_COLOR, type MapTone } from './mapStatus';

export const CELL = 48;

/** "#3ccf82", 0.2 -> "rgba(60, 207, 130, 0.2)" */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const STAND = '#2a3244';
const DISK_COLOR: Record<DiskLevel, string> = { ok: 'transparent', warn: '#f3b33d', crit: '#ff5c5c' };

interface PcGlyphProps {
  id: number;
  x: number;
  y: number;
  tone: MapTone;
  selected: boolean;
  /** Filtered out by the zone / search filter */
  dim: boolean;
  disk: DiskLevel;
  /** 0..1 while SteamCMD downloads, otherwise null */
  progress: number | null;
  /** Rendered under the pointer while dragging / placing */
  ghost?: boolean;
}

function PcGlyphImpl({ id, x, y, tone, selected, dim, disk, progress, ghost }: PcGlyphProps) {
  const c = TONE_COLOR[tone];
  const empty = tone === 'empty';
  const dark = empty || tone === 'offline';
  return (
    <g
      className={`map-pc tone-${tone}${dim ? ' dim' : ''}${ghost ? ' ghost' : ''}${selected ? ' selected' : ''}`}
      data-pc={ghost ? undefined : id}
      transform={`translate(${x * CELL} ${y * CELL})`}
    >
      <rect className="pc-hit" x={1} y={1} width={46} height={46} rx={9} />
      {selected && <rect className="pc-sel" x={1.5} y={1.5} width={45} height={45} rx={9} />}
      <path d="M21 32h6l1.2 5h-8.4z" fill={STAND} />
      <rect x={15} y={37} width={18} height={3} rx={1.5} fill={STAND} />
      <rect x={6} y={5} width={36} height={27} rx={4} fill={dark ? '#161a22' : '#1a2030'} />
      <rect
        className="pc-body"
        x={6}
        y={5}
        width={36}
        height={27}
        rx={4}
        fill={dark ? 'transparent' : alpha(c, 0.13)}
        stroke={empty ? '#3a4152' : alpha(c, dark ? 0.55 : 0.75)}
        strokeWidth={1.5}
        strokeDasharray={empty ? '3 3' : undefined}
      />
      <text x={24} y={17.5} className="pc-num" textAnchor="middle" dominantBaseline="central" fontSize={id >= 100 ? 11 : 14} fill={dark ? '#6f788b' : '#eef1f6'}>
        {id}
      </text>
      {!empty &&
        (progress == null ? (
          <rect className="pc-strip" x={9} y={26} width={30} height={3.5} rx={1.75} fill={c} />
        ) : (
          <>
            <rect x={9} y={26} width={30} height={3.5} rx={1.75} fill={alpha(c, 0.25)} />
            <rect className="pc-strip" x={9} y={26} width={Math.max(3.5, 30 * progress)} height={3.5} rx={1.75} fill={c} />
          </>
        ))}
      {disk !== 'ok' && <circle cx={40} cy={7} r={4.2} fill={DISK_COLOR[disk]} stroke="#13161f" strokeWidth={2} />}
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

const LANDMARK_COLOR = { entrance: '#c6ccd8', reception: '#c6ccd8', wc: '#c6ccd8', extinguisher: '#ff6b6b' } as const;
const LANDMARK_CAPTION = { entrance: 'ВХІД', reception: 'АДМІН', wc: '', extinguisher: '' } as const;

export function LandmarkGlyph({ m, ghost }: { m: MapLandmark; ghost?: boolean }) {
  const color = LANDMARK_COLOR[m.kind];
  const small = m.kind === 'extinguisher';
  const r = small ? 12 : 16;
  return (
    <g className={`map-landmark${ghost ? ' ghost' : ''}`} data-landmark={ghost ? undefined : m.id} transform={`translate(${m.x * CELL} ${m.y * CELL})`}>
      <rect className="lm-box" x={-r} y={-r} width={r * 2} height={r * 2} rx={small ? 6 : 8} fill="#1b2130" stroke={alpha(color, 0.35)} />
      {m.kind === 'wc' ? (
        <text x={0} y={0.5} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={800} fill={color} letterSpacing={0.5}>
          WC
        </text>
      ) : (
        <g transform={`rotate(${m.kind === 'entrance' ? m.rot : 0})`}>
          {m.kind === 'entrance' && <ArrowBigDown x={-11} y={-11} width={22} height={22} color={color} strokeWidth={2} />}
          {m.kind === 'reception' && <ConciergeBell x={-10} y={-10} width={20} height={20} color={color} strokeWidth={2} />}
          {m.kind === 'extinguisher' && <FireExtinguisher x={-8} y={-8} width={16} height={16} color={color} strokeWidth={2} />}
        </g>
      )}
      {LANDMARK_CAPTION[m.kind] && (
        <text className="lm-caption" x={0} y={r + 11} textAnchor="middle" fontSize={9.5} fontWeight={700} letterSpacing={1.2}>
          {LANDMARK_CAPTION[m.kind]}
        </text>
      )}
    </g>
  );
}

const ZONE_LABEL_COLOR: Record<string, string> = { Stream: alpha('#9a8bff', 0.85), Regular: '#5d6679' };

export function LabelGlyph({ t, ghost }: { t: MapLabel; ghost?: boolean }) {
  const width = t.text.length * 10.5 + 22;
  return (
    <g className={`map-label${ghost ? ' ghost' : ''}`} data-label={ghost ? undefined : t.id} transform={`translate(${t.x * CELL} ${t.y * CELL})`}>
      <rect className="lbl-hit" x={-width / 2} y={-12} width={width} height={24} rx={6} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={750} letterSpacing={3} fill={ZONE_LABEL_COLOR[t.zone ?? ''] ?? '#7d879a'}>
        {t.text.toUpperCase()}
      </text>
    </g>
  );
}
