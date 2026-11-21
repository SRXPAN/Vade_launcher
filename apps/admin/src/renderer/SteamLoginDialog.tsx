import { CircleCheck, CircleX, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { PcRuntime } from '@vade/protocol';
import type { SteamLoginReply } from '../shared/api';
import { api, errorText } from './api';
import { Modal } from './ui';

interface Props {
  pcIds: number[];
  defaultUser: string;
  runtimes: Record<number, PcRuntime>;
  onClose: () => void;
}

/**
 * SteamCMD must log in once per PC as SYSTEM (the account of the agent), otherwise the night
 * update fails with "Cached credentials not found". The password is sealed with the session key
 * of each agent connection and never stored.
 */
export function SteamLoginDialog({ pcIds, defaultUser, runtimes, onClose }: Props) {
  const [user, setUser] = useState(defaultUser);
  const [password, setPassword] = useState('');
  const [guard, setGuard] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<number, SteamLoginReply>>({});
  const [error, setError] = useState<string | null>(null);

  const pending = pcIds.filter((id) => !results[id]?.ok);
  const offline = pending.filter((id) => runtimes[id]?.link !== 'online');
  const targets = pending.filter((id) => runtimes[id]?.link === 'online');
  const needsGuard = Object.values(results).some((r) => r.result?.outcome === 'guard_required' || r.result?.outcome === 'guard_mismatch');

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const replies = await api.steamLogin({ pcIds: targets, user: user.trim(), password, guardCode: guard.trim() || undefined });
      setResults((prev) => ({ ...prev, ...Object.fromEntries(replies.map((r) => [r.pcId, r])) }));
      setGuard('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Вхід SteamCMD на ігрових ПК"
      icon={<KeyRound size={18} color="var(--accent)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Закрити
          </button>
          <button className="btn primary" disabled={busy || !user.trim() || !password || targets.length === 0} onClick={() => void run()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}
            {Object.keys(results).length ? `Повторити для ${targets.length} ПК` : `Увійти на ${targets.length} ПК`}
          </button>
        </>
      }
    >
      <div className="notice" style={{ marginBottom: 14 }}>
        <ShieldCheck size={16} />
        <span>
          Потрібно один раз на кожному ПК. Пароль передається агенту зашифрованим і ніде не зберігається — SteamCMD запам'ятовує вхід сам.
          Код Steam Guard діє ~30 с, тому для кількох ПК вводьте новий код і повторюйте для тих, де він знадобився.
        </span>
      </div>
      {error && <div className="errors">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>Логін Steam клубу</label>
          <input className="input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </div>
        <div className="field full">
          <label>Код Steam Guard {needsGuard && <span className="s-error">— потрібен</span>}</label>
          <input
            className={`input mono ${needsGuard && !guard ? 'invalid' : ''}`}
            value={guard}
            onChange={(e) => setGuard(e.target.value.toUpperCase())}
            placeholder="необов'язково: з застосунку Steam або пошти"
            maxLength={8}
          />
        </div>
      </div>
      <table className="scan" style={{ marginTop: 14 }}>
        <tbody>
          {pcIds.map((id) => {
            const r = results[id];
            const isOnline = runtimes[id]?.link === 'online';
            return (
              <tr key={id}>
                <td style={{ width: 70 }}>ПК №{id}</td>
                <td>
                  {r ? (
                    r.ok ? (
                      <span className="s-ok" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <CircleCheck size={14} /> {r.result?.message}
                      </span>
                    ) : (
                      <span className="s-error" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <CircleX size={14} /> {r.result?.message ?? r.error}
                      </span>
                    )
                  ) : busy && isOnline ? (
                    <span className="s-running">виконується…</span>
                  ) : isOnline ? (
                    <span className="dim">очікує</span>
                  ) : (
                    <span className="dim">не в мережі — пропущено</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {offline.length > 0 && <p className="hint">Не в мережі: {offline.join(', ')}. Увімкніть їх і повторіть.</p>}
    </Modal>
  );
}
