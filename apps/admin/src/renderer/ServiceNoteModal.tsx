import { Clock, LoaderCircle, Trash2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PcRecord } from '@vade/protocol';
import { api, errorText } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';
import { Modal, Option, useToast } from './ui';

export interface ServiceNoteModalProps {
  pc: PcRecord;
  operatorName?: string;
  onClose: () => void;
  onSaved: (pcs: PcRecord[]) => void;
}

/** Modal for toggling PC repair status ("Out of Service") and editing shift desk notes. */
export function ServiceNoteModal({ pc, operatorName, onClose, onSaved }: ServiceNoteModalProps) {
  const { t, locale } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const toast = useToast();

  const [outOfService, setOutOfService] = useState(() => Boolean(pc.serviceNote?.outOfService));
  const [text, setText] = useState(() => pc.serviceNote?.text ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOutOfService(Boolean(pc.serviceNote?.outOfService));
    setText(pc.serviceNote?.text ?? '');
    setError(null);
  }, [pc.id, pc.serviceNote]);

  const updatedLabel = pc.serviceNote
    ? fmtDateTime(new Date(pc.serviceNote.updatedAt).toISOString(), locale, t('common.todayTime'))
    : '';

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const cleanText = text.trim();
      const nextPcs = await api.setPcServiceNote(pc.id, {
        outOfService,
        text: cleanText,
        author: operatorName?.trim() || undefined,
      });
      toast('ok', outOfService ? tr('note.savedRepairToast', { id: pc.id }) : tr('note.savedToast', { id: pc.id }));
      onSaved(nextPcs);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const nextPcs = await api.setPcServiceNote(pc.id, null);
      await api.recordAudit('pc.note_set', [String(pc.id)], 'cleared').catch(() => undefined);
      toast('ok', tr('note.clearedToast', { id: pc.id }));
      onSaved(nextPcs);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={tr('note.modalTitle', { id: pc.id })}
      icon={<Wrench size={18} color={outOfService ? 'var(--occ)' : 'var(--warn)'} />}
      onClose={onClose}
      footer={
        <>
          {pc.serviceNote && (
            <button type="button" className="btn danger ghost" disabled={saving} onClick={() => void clear()}>
              <Trash2 size={14} />
              {tr('note.clearBtn')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving || (!pc.serviceNote && !outOfService && !text.trim())}
            onClick={() => void save()}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            {t('common.save')}
          </button>
        </>
      }
    >
      {error && <div className="errors">{error}</div>}
      <div
        style={{
          border: `1px solid ${outOfService ? 'color-mix(in srgb, var(--occ) 45%, var(--border))' : 'var(--border)'}`,
          borderRadius: 'var(--radius-sm)',
          padding: '2px 12px',
          background: outOfService ? 'var(--occ-soft)' : 'var(--panel-2)',
          marginBottom: 12,
        }}
      >
        <Option
          title={tr('note.outOfServiceTitle')}
          desc={tr('note.outOfServiceDesc')}
          on={outOfService}
          onChange={setOutOfService}
          disabled={saving}
        />
      </div>

      <div className="field">
        <label htmlFor={`service-note-text-${pc.id}`}>{tr('note.textLabel')}</label>
        <textarea
          id={`service-note-text-${pc.id}`}
          className="input"
          rows={4}
          autoFocus
          disabled={saving}
          value={text}
          placeholder={tr('note.textPlaceholder')}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {pc.serviceNote && (
        <div
          className="hint"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 10,
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
          }}
        >
          <Clock size={13} />
          <span>
            {pc.serviceNote.author
              ? tr('note.lastUpdatedBy', { time: updatedLabel, author: pc.serviceNote.author })
              : tr('note.lastUpdated', { time: updatedLabel })}
          </span>
        </div>
      )}
    </Modal>
  );
}
