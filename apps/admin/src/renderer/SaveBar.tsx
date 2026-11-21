import { Save, Undo2 } from 'lucide-react';

export function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="savebar">
      <div className="savebar-inner">
        <span className="muted">Є незбережені зміни</span>
        <button className="btn" onClick={onReset}>
          <Undo2 size={15} /> Скасувати
        </button>
        <button className="btn primary" disabled={saving} onClick={onSave}>
          <Save size={15} /> Зберегти
        </button>
      </div>
    </div>
  );
}
