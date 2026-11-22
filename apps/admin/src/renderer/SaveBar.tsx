import { Save, Undo2 } from 'lucide-react';
import { useI18n } from './i18n';

export function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const { t } = useI18n();
  if (!dirty) return null;
  return (
    <div className="savebar">
      <div className="savebar-inner">
        <span className="muted">{t('common.unsaved')}</span>
        <button className="btn" onClick={onReset}>
          <Undo2 size={15} /> {t('common.cancel')}
        </button>
        <button className="btn primary" disabled={saving} onClick={onSave}>
          <Save size={15} /> {t('common.save')}
        </button>
      </div>
    </div>
  );
}
