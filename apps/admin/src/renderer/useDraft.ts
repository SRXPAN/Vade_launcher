import { useEffect, useState } from 'react';
import type { AppSettings } from '@vade/protocol';
import { api, errorText } from './api';
import { useI18n } from './i18n';
import { useToast } from './ui';

/** Local editable copy of the settings with dirty tracking and save/reset. */
export function useDraft(settings: AppSettings, onSaved: (s: AppSettings) => void) {
  const { t } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const update = (fn: (d: AppSettings) => void) =>
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const reset = () => {
    setDraft(settings);
    setError(null);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSettings(draft);
      onSaved(saved);
      toast('ok', t('common.savedToast'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return { draft, update, dirty, reset, save, error, saving };
}
