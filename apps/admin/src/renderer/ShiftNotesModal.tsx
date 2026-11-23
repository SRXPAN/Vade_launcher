import { ClipboardList, LoaderCircle, Pencil, Plus, ScrollText, StickyNote, Trash2, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PcRecord } from '@vade/protocol';
import type { PcServiceNoteInput } from '../shared/api';
import { api, errorText } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';
import { Modal, useToast } from './ui';

export interface ShiftNotesModalProps {
  pcs: PcRecord[];
  operatorName?: string;
  onEditNote: (pc: PcRecord) => void;
  onLogs: (pcId: number) => void;
  onUpdated: (pcs: PcRecord[]) => void;
  onClose: () => void;
}

/** Shift handover panel listing Out-of-Service PCs and active desk notes with quick actions. */
export function ShiftNotesModal({ pcs, operatorName, onEditNote, onLogs, onUpdated, onClose }: ShiftNotesModalProps) {
  const { t, locale } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const toast = useToast();

  const sortedPcs = useMemo(() => [...pcs].sort((a, b) => a.id - b.id), [pcs]);
  const repairPcs = useMemo(() => sortedPcs.filter((p) => p.serviceNote?.outOfService), [sortedPcs]);
  const notePcs = useMemo(
    () => sortedPcs.filter((p) => !p.serviceNote?.outOfService && Boolean(p.serviceNote?.text?.trim())),
    [sortedPcs],
  );

  const [selectedPcId, setSelectedPcId] = useState<number>(() => sortedPcs[0]?.id ?? 0);
  const [busyPcId, setBusyPcId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedPc = sortedPcs.find((p) => p.id === selectedPcId) ?? sortedPcs[0];

  const mutateNote = async (pc: PcRecord, note: PcServiceNoteInput | null, toastText: string) => {
    if (busyPcId != null) return;
    setBusyPcId(pc.id);
    setError(null);
    try {
      const nextPcs = await api.setPcServiceNote(pc.id, note);
      toast('ok', toastText);
      onUpdated(nextPcs);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyPcId(null);
    }
  };

  const clearRepair = (pc: PcRecord) => {
    const cleanText = pc.serviceNote?.text?.trim() ?? '';
    const nextNote: PcServiceNoteInput | null = cleanText
      ? {
          outOfService: false,
          text: cleanText,
          author: operatorName?.trim() || pc.serviceNote?.author || undefined,
        }
      : null;
    void mutateNote(pc, nextNote, tr('shift.repairClearedToast', { id: pc.id }));
  };

  const markRepair = (pc: PcRecord) => {
    const cleanText = pc.serviceNote?.text?.trim() ?? '';
    void mutateNote(
      pc,
      {
        outOfService: true,
        text: cleanText,
        author: operatorName?.trim() || pc.serviceNote?.author || undefined,
      },
      tr('shift.repairMarkedToast', { id: pc.id }),
    );
  };

  const clearNote = (pc: PcRecord) => {
    void mutateNote(pc, null, tr('note.clearedToast', { id: pc.id }));
  };

  const formatMeta = (pc: PcRecord) => {
    const note = pc.serviceNote;
    if (!note) return '';
    const time = fmtDateTime(new Date(note.updatedAt).toISOString(), locale, t('common.todayTime'));
    return note.author ? `${note.author} · ${time}` : time;
  };

  const renderItem = (pc: PcRecord, kind: 'repair' | 'note') => {
    const note = pc.serviceNote;
    const isBusy = busyPcId === pc.id;
    const isRepair = kind === 'repair';
    const cleanText = note?.text?.trim() ?? '';

    return (
      <div
        key={pc.id}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--panel-2)',
          border: `1px solid ${isRepair ? 'color-mix(in srgb, var(--occ) 40%, var(--border))' : 'var(--border)'}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong>{t('common.pcNum', { id: pc.id })}</strong>
          <span className={`tag zone-${pc.zone}`}>{pc.zone}</span>
          {isRepair ? (
            <span
              className="repair-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '1px 7px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--occ)',
                background: 'var(--occ-soft)',
              }}
            >
              <Wrench size={11} />
              {tr('note.repairBadge')}
            </span>
          ) : (
            <span
              className="note-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '1px 7px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--warn)',
                background: 'var(--warn-soft)',
              }}
            >
              <StickyNote size={11} />
              {tr('shift.noteBadge')}
            </span>
          )}
          <span className="spacer" />
          <span className="hint">{formatMeta(pc)}</span>
        </div>

        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {cleanText || <span className="dim">{tr('shift.emptyRepairText')}</span>}
        </div>

        <div className="btn-group">
          {isRepair ? (
            <>
              <button type="button" className="btn small" disabled={busyPcId != null} onClick={() => clearRepair(pc)}>
                {isBusy ? <LoaderCircle size={13} className="spin" /> : <Wrench size={13} />}
                {tr('shift.clearRepairBtn')}
              </button>
              <button type="button" className="btn small" disabled={busyPcId != null} onClick={() => onEditNote(pc)}>
                <Pencil size={13} />
                {tr('shift.editBtn')}
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busyPcId != null}
                onClick={() => {
                  onClose();
                  onLogs(pc.id);
                }}
              >
                <ScrollText size={13} />
                {tr('shift.liveLogBtn')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn small" disabled={busyPcId != null} onClick={() => markRepair(pc)}>
                {isBusy ? <LoaderCircle size={13} className="spin" /> : <Wrench size={13} />}
                {tr('shift.markRepairBtn')}
              </button>
              <button type="button" className="btn small" disabled={busyPcId != null} onClick={() => onEditNote(pc)}>
                <Pencil size={13} />
                {tr('shift.editBtn')}
              </button>
              <button type="button" className="btn small danger ghost" disabled={busyPcId != null} onClick={() => clearNote(pc)}>
                <Trash2 size={13} />
                {tr('shift.clearNoteBtn')}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      wide
      title={tr('shift.title')}
      icon={<ClipboardList size={18} color="var(--warn)" />}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '8px 10px',
          marginBottom: 14,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
        }}
      >
        <span className="hint" style={{ fontWeight: 600 }}>
          {tr('shift.addNoteLabel')}
        </span>
        <select
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          disabled={sortedPcs.length === 0 || busyPcId != null}
          value={selectedPc?.id ?? ''}
          onChange={(e) => setSelectedPcId(Number(e.target.value))}
        >
          {sortedPcs.map((p) => (
            <option key={p.id} value={p.id}>
              {t('common.pcNum', { id: p.id })} · {p.zone}
              {p.name ? ` · ${p.name}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn small primary"
          disabled={!selectedPc || busyPcId != null}
          onClick={() => selectedPc && onEditNote(selectedPc)}
        >
          <Plus size={14} />
          {tr('shift.addNoteBtn')}
        </button>
      </div>

      {error && <div className="errors">{error}</div>}

      {repairPcs.length === 0 && notePcs.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '32px 16px',
            textAlign: 'center',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
          }}
        >
          <ClipboardList size={28} color="var(--text-3)" />
          <div style={{ fontWeight: 600 }}>{tr('shift.emptyTitle')}</div>
          <div className="hint" style={{ maxWidth: 420 }}>
            {tr('shift.emptyDesc')}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {repairPcs.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--occ)',
                }}
              >
                <Wrench size={14} />
                <span>{tr('shift.repairSection', { count: repairPcs.length })}</span>
              </div>
              {repairPcs.map((pc) => renderItem(pc, 'repair'))}
            </section>
          )}

          {notePcs.length > 0 && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--warn)',
                }}
              >
                <StickyNote size={14} />
                <span>{tr('shift.notesSection', { count: notePcs.length })}</span>
              </div>
              {notePcs.map((pc) => renderItem(pc, 'note'))}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
