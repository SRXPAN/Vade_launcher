/** Modals used by the club map editor (pick existing PC, reserve slot, label, zone box). */
import { Monitor, Search, Square, SquareDashed, Type } from 'lucide-react';
import { useState } from 'react';
import type { PcRecord } from '@vade/protocol';
import { MAP_LIMITS, ZONE_COLORS } from '../../shared/mapLayout';
import { Modal } from '../ui';

/* ------------------------------------------------------------------ */
/* Pick an existing unplaced PC from pcs.json                          */
/* ------------------------------------------------------------------ */

export function ExistingPcDialog(props: {
  title: string;
  hint: string;
  pcs: PcRecord[];
  onPick: (pc: PcRecord) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const list = props.pcs.filter((p) => {
    if (!term) return true;
    return [String(p.id), p.zone, p.ip, p.mac, p.name ?? ''].some((v) => v.toLowerCase().includes(term));
  });

  return (
    <Modal
      title={props.title}
      icon={<Monitor size={18} color="var(--accent)" />}
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          Закрити
        </button>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        {props.hint}
      </p>
      {props.pcs.length === 0 ? (
        <div className="notice">Усі ПК із бази (pcs.json) уже розміщено на карті.</div>
      ) : (
        <>
          {props.pcs.length > 6 && (
            <div className="search" style={{ width: '100%' }}>
              <Search size={15} />
              <input
                className="input"
                style={{ width: '100%' }}
                autoFocus
                placeholder="Пошук за номером, зоною, IP або назвою…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}
          <div className="pc-picker">
            {list.length === 0 ? (
              <div className="dim" style={{ padding: '12px 4px' }}>
                Нічого не знайдено.
              </div>
            ) : (
              list.map((pc) => (
                <button key={pc.id} type="button" className="pc-picker-row" onClick={() => props.onPick(pc)}>
                  <span className="pc-picker-num">№{pc.id}</span>
                  <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
                  <span className="ellipsis muted">{pc.name || pc.ip}</span>
                  <span className="mono dim">{pc.ip}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Add an empty reserve slot                                           */
/* ------------------------------------------------------------------ */

export function EmptySlotDialog(props: {
  suggestedId: number;
  usedOnMap: Set<number>;
  existingPcIds: Set<number>;
  onDone: (id: number) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(String(props.suggestedId));
  const id = Number(val);
  const validInt = Number.isInteger(id) && id >= 1 && id <= 999;
  const onMap = validInt && props.usedOnMap.has(id);
  const inDb = validInt && props.existingPcIds.has(id);
  const canSubmit = validInt && !onMap && !inDb;

  const submit = () => {
    if (canSubmit) props.onDone(id);
  };

  return (
    <Modal
      title="Додати порожній слот (резерв)"
      icon={<SquareDashed size={18} color="var(--accent)" />}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            Поставити на карту
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Пунктирний слот для майбутнього столу. Пізніше одним кліком можна прив’язати існуючий або створити новий ПК.
      </p>
      <div className="field">
        <label>Номер майбутнього столу</label>
        <input
          className={`input ${val && !canSubmit ? 'invalid' : ''}`}
          type="number"
          min={1}
          max={999}
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {onMap && <span className="hint" style={{ color: 'var(--err)' }}>Місце №{id} уже є на карті.</span>}
        {!onMap && inDb && (
          <span className="hint" style={{ color: 'var(--warn)' }}>
            ПК №{id} уже існує в базі — додайте його через «Додати існуючий ПК на карту…».
          </span>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Label create / edit dialog                                          */
/* ------------------------------------------------------------------ */

export function LabelDialog(props: {
  initial?: { text: string; zone?: string };
  onClose: () => void;
  onDone: (text: string, zone: string | undefined) => void;
}) {
  const [text, setText] = useState(props.initial?.text ?? '');
  const [zone, setZone] = useState(props.initial ? (props.initial.zone ?? '') : 'Regular');
  const ok = text.trim().length > 0;
  const submit = () => ok && props.onDone(text.trim(), zone || undefined);

  return (
    <Modal
      title={props.initial ? 'Редагувати підпис' : 'Підпис зони'}
      icon={<Type size={18} color="var(--accent)" />}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!ok} onClick={submit}>
            {props.initial ? 'Зберегти' : 'Поставити на карту'}
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
            onKeyDown={(e) => e.key === 'Enter' && submit()}
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

/* ------------------------------------------------------------------ */
/* Zone box create / edit dialog                                       */
/* ------------------------------------------------------------------ */

const ZONE_PRESETS = [
  { name: 'Regular', color: '#4f8cff' },
  { name: 'Stream', color: '#9a8bff' },
  { name: 'VIP', color: '#eab308' },
  { name: 'Bootcamp', color: '#10b981' },
  { name: 'Lounge', color: '#06b6d4' },
];

export function ZoneBoxDialog(props: {
  initial?: { name: string; color: string };
  onClose: () => void;
  onDone: (name: string, color: string) => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? 'VIP');
  const [color, setColor] = useState(props.initial?.color ?? ZONE_COLORS[2].value);
  const ok = name.trim().length > 0;
  const submit = () => ok && props.onDone(name.trim(), color);

  return (
    <Modal
      title={props.initial ? 'Налаштування рамки зони' : 'Нова рамка зони'}
      icon={<Square size={18} color={color} />}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!ok} onClick={submit}>
            {props.initial ? 'Зберегти' : 'Намалювати на карті'}
          </button>
        </>
      }
    >
      {!props.initial && (
        <p className="hint" style={{ marginTop: 0 }}>
          Після підтвердження протягніть прямокутник на сітці (або клікніть один раз для стандартного 4×3). Потім його можна розтягувати за кути й краї.
        </p>
      )}
      <div className="form-grid">
        <div className="field full">
          <label>Назва зони</label>
          <input
            className="input"
            autoFocus
            maxLength={MAP_LIMITS.maxZoneNameLength}
            value={name}
            placeholder="наприклад VIP, Stream, Regular"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="zone-presets">
            {ZONE_PRESETS.map((pr) => (
              <button
                key={pr.name}
                type="button"
                className={`chip ${name === pr.name ? 'active' : ''}`}
                onClick={() => {
                  setName(pr.name);
                  setColor(pr.color);
                }}
              >
                {pr.name}
              </button>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Колір виділення</label>
          <div className="color-swatches">
            {ZONE_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`color-swatch ${color.toLowerCase() === c.value ? 'active' : ''}`}
                style={{ background: c.value }}
                title={c.label}
                onClick={() => setColor(c.value)}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
