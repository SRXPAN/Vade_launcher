import { LoaderCircle, MessageSquare, Send } from 'lucide-react';
import { useState } from 'react';
import type { PcRecord } from '@vade/protocol';
import { api, errorText } from './api';
import { useI18n } from './i18n';
import { Modal, useToast } from './ui';

interface Props {
  pc: PcRecord;
  onClose: () => void;
}

export function NotifyModal({ pc, onClose }: Props) {
  const { t } = useI18n();
  const tr = (k: string, p?: Record<string, string | number>) => t(k as never, p);
  const toast = useToast();
  const defaultTitle = t('app.name');

  const [title, setTitle] = useState(defaultTitle);
  const [message, setMessage] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = message.trim().length > 0 && !sending;

  const submit = async () => {
    const cleanMessage = message.trim().slice(0, 1000);
    if (!cleanMessage || sending) return;
    const cleanTitle = (title.trim() || defaultTitle).slice(0, 120);
    const clampedTimeout = Math.max(5, Math.min(300, Number.isFinite(timeoutSec) ? Math.round(timeoutSec) : 30));

    setSending(true);
    setError(null);
    try {
      const res = await api.diagNotify(pc.id, {
        title: cleanTitle,
        message: cleanMessage,
        timeoutSec: clampedTimeout,
      });
      if (res.ok) {
        void api.recordAudit('diag.notify', [String(pc.id)], cleanTitle).catch(() => undefined);
        toast('ok', res.message);
        onClose();
      } else {
        setError(res.message);
        toast('warn', res.message);
      }
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      toast('error', msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      title={tr('notify.title', { id: pc.id })}
      icon={<MessageSquare size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={sending}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {sending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
            {tr('notify.send')}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {tr('notify.hint')}
      </p>
      {error && <div className="errors">{error}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div className="field">
          <label>{tr('notify.fieldTitle')}</label>
          <input
            type="text"
            className="input"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={defaultTitle}
          />
        </div>

        <div className="field">
          <label>{tr('notify.fieldMessage')}</label>
          <textarea
            className="input"
            rows={4}
            maxLength={1000}
            autoFocus
            required
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={tr('notify.messagePlaceholder')}
          />
        </div>

        <div className="field" style={{ maxWidth: 200 }}>
          <label>{tr('notify.fieldTimeout')}</label>
          <input
            type="number"
            className="input"
            min={5}
            max={300}
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(Number(e.target.value))}
          />
          <span className="hint">{tr('notify.timeoutHint')}</span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
