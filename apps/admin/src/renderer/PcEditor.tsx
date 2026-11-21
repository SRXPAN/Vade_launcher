import { Monitor, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AFTER_ACTION_TITLES, normalizeMac, parseAppIds, validatePc, type AfterAction, type PcRecord } from '@vade/protocol';
import { api, errorText } from './api';
import { ConfirmDialog, Modal, Switch, useToast } from './ui';

interface Props {
  initial: PcRecord;
  originalId: number | null;
  pcs: PcRecord[];
  zones: string[];
  onClose: () => void;
  onSaved: (pcs: PcRecord[]) => void;
}

export function PcEditor({ initial, originalId, pcs, zones, onClose, onSaved }: Props) {
  const toast = useToast();
  const [id, setId] = useState(String(initial.id));
  const [ip, setIp] = useState(initial.ip);
  const [mac, setMac] = useState(initial.mac);
  const [zone, setZone] = useState(initial.zone);
  const [name, setName] = useState(initial.name ?? '');
  const [scheduled, setScheduled] = useState(initial.overrides?.scheduleEnabled !== false);
  const [after, setAfter] = useState<AfterAction | ''>(initial.overrides?.afterAction ?? '');
  const [appIds, setAppIds] = useState((initial.overrides?.updateAppIds ?? []).join(', '));
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [customZone, setCustomZone] = useState(!zones.includes(initial.zone));

  const build = (): PcRecord | string[] => {
    const ids = parseAppIds(appIds);
    if (ids == null) return ['Список AppID: лише числа через кому.'];
    const pc: PcRecord = { id: Number(id), ip: ip.trim(), mac: normalizeMac(mac) ?? mac.trim(), zone: zone.trim() };
    if (name.trim()) pc.name = name.trim();
    const overrides: PcRecord['overrides'] = {};
    if (!scheduled) overrides.scheduleEnabled = false;
    if (after) overrides.afterAction = after;
    if (ids.length) overrides.updateAppIds = ids;
    if (Object.keys(overrides).length) pc.overrides = overrides;
    const errs = validatePc(pc, pcs, originalId);
    return errs.length ? errs : pc;
  };

  const save = async () => {
    const pc = build();
    if (Array.isArray(pc)) return setErrors(pc);
    setSaving(true);
    try {
      const r = await api.savePc(pc, originalId);
      if (!r.ok) return setErrors(r.errors);
      toast('ok', originalId == null ? `ПК №${pc.id} додано` : `ПК №${pc.id} збережено`);
      onSaved(r.pcs);
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (originalId == null) return;
    try {
      const list = await api.deletePcs([originalId]);
      toast('ok', `ПК №${originalId} видалено`);
      onSaved(list);
    } catch (e) {
      setErrors([errorText(e)]);
    }
  };

  return (
    <Modal
      title={originalId == null ? 'Новий ПК' : `ПК №${originalId}`}
      icon={<Monitor size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          {originalId != null && (
            <button className="btn danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={15} /> Видалити
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Скасувати
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            Зберегти
          </button>
        </>
      }
    >
      {errors.length > 0 && <div className="errors">{errors.join('\n')}</div>}
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label>Номер столу</label>
          <input className="input" type="number" min={1} max={999} value={id} onChange={(e) => setId(e.target.value)} autoFocus />
          <span className="hint">Визначає час у нічному розкладі.</span>
        </div>
        <div className="field">
          <label>Зона</label>
          {customZone ? (
            <input className="input" value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Назва зони" />
          ) : (
            <select
              className="input"
              value={zone}
              onChange={(e) => {
                if (e.target.value === '__new') {
                  setCustomZone(true);
                  setZone('');
                } else setZone(e.target.value);
              }}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
              <option value="__new">+ Нова зона…</option>
            </select>
          )}
        </div>
        <div className="field">
          <label>IP-адреса</label>
          <input className="input mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.70.4.130" />
        </div>
        <div className="field">
          <label>MAC-адреса</label>
          <input className="input mono" value={mac} onChange={(e) => setMac(e.target.value)} onBlur={() => setMac((m) => normalizeMac(m) ?? m)} placeholder="30:56:0f:3e:00:00" />
        </div>
        <div className="field full">
          <label>Назва (необов'язково)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Напр. «Біля вікна» або ім'я ПК" />
        </div>

        <div className="field full" style={{ marginTop: 6 }}>
          <div className="label">Індивідуальні налаштування</div>
        </div>
        <div className="field full" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Switch on={scheduled} onChange={setScheduled} label="У нічному розкладі" />
          <span>Включати в нічний розклад</span>
        </div>
        <div className="field">
          <label>Дія після завершення</label>
          <select className="input" value={after} onChange={(e) => setAfter(e.target.value as AfterAction | '')}>
            <option value="">Як у глобальних налаштуваннях</option>
            {(Object.keys(AFTER_ACTION_TITLES) as AfterAction[]).map((a) => (
              <option key={a} value={a}>
                {AFTER_ACTION_TITLES[a]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Оновлювати лише AppID</label>
          <input className="input mono" value={appIds} onChange={(e) => setAppIds(e.target.value)} placeholder="порожньо = глобально" />
        </div>
        <button type="submit" hidden />
      </form>
      {confirmDelete && (
        <ConfirmDialog
          title={`Видалити ПК №${originalId}?`}
          text="ПК зникне зі списку та нічного розкладу. Агент на самому ПК залишиться встановленим."
          confirmLabel="Видалити"
          danger
          onConfirm={() => void remove()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  );
}
