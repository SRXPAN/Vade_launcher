import { KeyRound, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { api, errorText } from './api';
import { useI18n } from './i18n';
import { Modal } from './ui';

interface Props {
  title?: string;
  description?: string;
  onVerified: (pin: string) => void;
  onClose: () => void;
}

export function PinPromptModal({ title, description, onVerified, onClose }: Props) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!pin.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      const ok = await api.verifyPin(pin);
      if (!ok) {
        setError(t('deploy.pinWrong'));
        return;
      }
      onVerified(pin);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal
      title={title ?? t('deploy.pinTitle')}
      icon={<KeyRound size={18} color="var(--warn)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={checking || !pin.trim()} onClick={() => void submit()}>
            {checking && <LoaderCircle size={15} className="spin" />}
            {t('common.confirm')}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {description ?? t('deploy.pinDesc')}
      </p>
      {error && <div className="errors">{error}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label>{t('deploy.pinPlaceholder')}</label>
          <input
            type="password"
            className="input mono"
            autoFocus
            value={pin}
            placeholder="••••"
            onChange={(e) => {
              setPin(e.target.value);
              setError(null);
            }}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
