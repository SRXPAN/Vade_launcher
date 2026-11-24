import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Globe,
  ImagePlus,
  LoaderCircle,
  Lock,
  Monitor,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Trash2,
  Tv,
  Upload,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  deriveTvConfigUrl,
  qrToSvgDataUrl,
  TV_LIMITS,
  type AppSettings,
  type TvDisplayConfig,
  type TvLang,
  type TvQrBgType,
  type TvQrCard,
  type TvQrSource,
  type TvSlide,
  type TvSlideMode,
} from '@vade/protocol';
import type { TvPublishStatus, TvServerStatus } from '../shared/api';
import { api, errorText } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';
import {
  buildWifiQrString,
  estimateDataUrlBytes,
  optimizeQrBgImage,
  optimizeQrCodeImage,
  optimizeSlideImage,
  type WifiSecurity,
} from './imageOpt';
import { useRole } from './role';
import { SaveBar } from './SaveBar';
import { Option, Segmented, Switch, useToast } from './ui';

interface Props {
  settings: AppSettings;
  onOpenSiteTab?: () => void;
}

interface WifiDraft {
  open: boolean;
  ssid: string;
  password: string;
  security: WifiSecurity;
}

const QR_BG_PRESETS = ['#161b26', '#0f172a', '#142622', '#251636', '#241717'] as const;

const PREVIEW_PC_TILES = [
  { id: 1, occ: false },
  { id: 2, occ: true },
  { id: 3, occ: true },
  { id: 4, occ: false },
  { id: 5, occ: true },
  { id: 6, occ: false },
  { id: 7, occ: true },
  { id: 8, occ: false },
  { id: 18, occ: true, stream: true },
  { id: 19, occ: false, stream: true },
] as const;

function nextUniqueId(prefix: string, existingIds: string[]): string {
  const used = new Set(existingIds);
  const stamp = Date.now().toString(36);
  let candidate = `${prefix}-${stamp}`;
  let idx = 1;
  while (used.has(candidate)) {
    candidate = `${prefix}-${stamp}-${idx++}`;
  }
  return candidate;
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function cloneConfig(cfg: TvDisplayConfig): TvDisplayConfig {
  return structuredClone(cfg);
}

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function safeQrDataUrl(text: string): { dataUrl: string | null; tooLong: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { dataUrl: null, tooLong: false };
  try {
    return { dataUrl: qrToSvgDataUrl(trimmed), tooLong: false };
  } catch {
    return { dataUrl: null, tooLong: true };
  }
}

function kbOf(dataUrl: string | undefined): number {
  if (!dataUrl) return 0;
  return Math.max(1, Math.round(estimateDataUrlBytes(dataUrl) / 1024));
}

function QrCardPreview({ card, emptyText, compact }: { card: TvQrCard; emptyText: string; compact?: boolean }) {
  const qr = useMemo(() => {
    if (card.qrSource === 'upload') {
      return { dataUrl: card.qrImageDataUrl ?? null, tooLong: false };
    }
    return safeQrDataUrl(card.qrText ?? '');
  }, [card.qrSource, card.qrImageDataUrl, card.qrText]);

  const bgStyle: CSSProperties =
    card.bgType === 'image' && card.bgImageDataUrl
      ? {
          backgroundImage: `linear-gradient(180deg, rgba(11,14,20,0.25) 0%, rgba(11,14,20,0.82) 100%), url(${card.bgImageDataUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : {
          background: card.bgColor || '#161b26',
        };

  return (
    <div
      style={{
        ...bgStyle,
        aspectRatio: '3 / 4',
        width: '100%',
        borderRadius: compact ? 6 : 10,
        border: '1px solid rgba(255,255,255,0.14)',
        padding: compact ? '6px 5px' : '10px 9px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        overflow: 'hidden',
        color: '#eef1f6',
        textAlign: 'center',
        position: 'relative',
      }}
    >
      <div
        style={{
          width: compact ? '74%' : '76%',
          aspectRatio: '1 / 1',
          background: '#ffffff',
          borderRadius: compact ? 4 : 7,
          padding: compact ? 3 : 5,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
        }}
      >
        {qr.dataUrl ? (
          <img
            src={qr.dataUrl}
            alt={card.label || 'QR'}
            style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
          />
        ) : (
          <div style={{ color: '#64748b', display: 'grid', placeItems: 'center', gap: 2 }}>
            <QrCode size={compact ? 14 : 26} />
            {!compact && <span style={{ fontSize: 10 }}>{emptyText}</span>}
          </div>
        )}
      </div>
      <div style={{ width: '100%', minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 8 : 11.5,
            fontWeight: 700,
            lineHeight: 1.15,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.label || '—'}
        </div>
        {card.sublabel && (
          <div
            style={{
              fontSize: compact ? 6.5 : 9.5,
              color: 'rgba(238,241,246,0.76)',
              lineHeight: 1.15,
              marginTop: compact ? 1 : 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {card.sublabel}
          </div>
        )}
      </div>
    </div>
  );
}

/** TV Kiosk display configuration editor: LAN server, website sync, 16:9 preview, promo banners, and 3:4 QR cards. */
export function TvView({ settings, onOpenSiteTab }: Props) {
  const { t, locale } = useI18n();
  const tr = useCallback((k: string, p?: Record<string, string | number>) => t(k as never, p), [t]);
  const toast = useToast();
  const { isOwner, requireOwner, openUnlock } = useRole();

  const [saved, setSaved] = useState<TvDisplayConfig | null>(null);
  const [draft, setDraft] = useState<TvDisplayConfig | null>(null);
  const [serverStatus, setServerStatus] = useState<TvServerStatus | null>(null);
  const [publishStatus, setPublishStatus] = useState<TvPublishStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [previewSlideIdx, setPreviewSlideIdx] = useState(0);
  const [wifiDrafts, setWifiDrafts] = useState<Record<string, WifiDraft>>({});

  const addSlideInputRef = useRef<HTMLInputElement>(null);
  const replaceSlideInputRef = useRef<HTMLInputElement>(null);
  const replaceSlideIdRef = useRef<string | null>(null);
  const qrCodeInputRef = useRef<HTMLInputElement>(null);
  const qrCodeCardIdRef = useRef<string | null>(null);
  const qrBgInputRef = useRef<HTMLInputElement>(null);
  const qrBgCardIdRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getTvConfig()
      .then((cfg) => {
        if (!alive) return;
        setSaved(cfg);
        setDraft(cloneConfig(cfg));
      })
      .catch((e) => {
        if (alive) toast('error', errorText(e));
      });
    void api
      .getTvServerStatus()
      .then((st) => {
        if (alive) setServerStatus(st);
      })
      .catch(() => undefined);
    void api
      .getTvPublishStatus()
      .then((st) => {
        if (alive) setPublishStatus(st);
      })
      .catch(() => undefined);

    const offServer = api.onTvServerStatus((st) => setServerStatus(st));
    const offPublish = api.onTvPublishStatus((st) => setPublishStatus(st));
    return () => {
      alive = false;
      offServer();
      offPublish();
    };
  }, [toast]);

  const dirty = useMemo(() => {
    if (!draft || !saved) return false;
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);

  const enabledSlides = useMemo(() => (draft ? draft.slides.filter((s) => s.enabled && s.imageDataUrl) : []), [draft]);
  const enabledCards = useMemo(() => (draft ? draft.qrCards.filter((c) => c.enabled) : []), [draft]);

  useEffect(() => {
    if (enabledSlides.length === 0) {
      setPreviewSlideIdx(0);
      return;
    }
    if (previewSlideIdx >= enabledSlides.length) {
      setPreviewSlideIdx(0);
    }
  }, [enabledSlides.length, previewSlideIdx]);

  useEffect(() => {
    if (enabledSlides.length <= 1 || !draft) return;
    const current = enabledSlides[previewSlideIdx] ?? enabledSlides[0];
    const sec = clampInt(current?.durationSec ?? draft.defaultSlideDurationSec, TV_LIMITS.minDurationSec, TV_LIMITS.maxDurationSec, TV_LIMITS.defaultDurationSec);
    const timer = window.setTimeout(() => {
      setPreviewSlideIdx((idx) => (idx + 1) % enabledSlides.length);
    }, sec * 1000);
    return () => window.clearTimeout(timer);
  }, [enabledSlides, previewSlideIdx, draft]);

  const mutateDraft = useCallback(
    (fn: (next: TvDisplayConfig) => void) => {
      requireOwner(tr('tv.unlockHint'), () => {
        setDraft((prev) => {
          if (!prev) return prev;
          const next = cloneConfig(prev);
          fn(next);
          return next;
        });
      });
    },
    [requireOwner, tr],
  );

  const persistDraft = useCallback(
    async (cfg: TvDisplayConfig): Promise<TvDisplayConfig> => {
      setSaving(true);
      try {
        const res = await api.saveTvConfig(cfg);
        setSaved(res);
        setDraft(cloneConfig(res));
        return res;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleSave = () => {
    if (!draft) return;
    requireOwner(tr('tv.unlockHint'), () => {
      void (async () => {
        try {
          await persistDraft(draft);
          toast('ok', tr('tv.savedToast'));
        } catch (e) {
          toast('error', errorText(e));
        }
      })();
    });
  };

  const handleReset = () => {
    if (!saved) return;
    setDraft(cloneConfig(saved));
    setWifiDrafts({});
  };

  const handlePublish = () => {
    if (!draft) return;
    requireOwner(tr('tv.unlockHint'), () => {
      void (async () => {
        setPublishing(true);
        try {
          if (dirty) {
            await persistDraft(draft);
          }
          const res = await api.publishTvConfig();
          if (res.ok) {
            toast('ok', tr('tv.publishOkToast'));
          } else {
            toast('error', res.error ?? `HTTP ${res.status ?? 'error'}`);
          }
          void api.getTvPublishStatus().then(setPublishStatus).catch(() => undefined);
        } catch (e) {
          toast('error', errorText(e));
        } finally {
          setPublishing(false);
        }
      })();
    });
  };

  const handleCopyUrl = (url: string) => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedUrl(url);
        toast('ok', tr('tv.urlCopied'));
        window.setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 1800);
      })
      .catch((e) => toast('error', errorText(e)));
  };

  const handleOpenPreview = () => {
    void api
      .openTvPreview()
      .then((res) => {
        if (!res.ok && res.error) toast('error', res.error);
      })
      .catch((e) => toast('error', errorText(e)));
  };

  const handleAddSlidesFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !draft) return;
    const remaining = TV_LIMITS.maxSlides - draft.slides.length;
    if (remaining <= 0) return;
    const picked = Array.from(files).slice(0, remaining);

    setOptimizing(true);
    try {
      const added: TvSlide[] = [];
      const existingIds = draft.slides.map((s) => s.id);
      for (const file of picked) {
        const opt = await optimizeSlideImage(file);
        const id = nextUniqueId('slide', existingIds);
        existingIds.push(id);
        added.push({
          id,
          enabled: true,
          imageDataUrl: opt.dataUrl,
          mode: 'image_only',
        });
      }
      setDraft((prev) => {
        if (!prev) return prev;
        const next = cloneConfig(prev);
        next.slides = [...next.slides, ...added].slice(0, TV_LIMITS.maxSlides);
        return next;
      });
    } catch (e) {
      toast('error', `${tr('tv.imageOptError')}: ${errorText(e)}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleReplaceSlideFile = async (files: FileList | null) => {
    const slideId = replaceSlideIdRef.current;
    replaceSlideIdRef.current = null;
    const file = files?.[0];
    if (!file || !slideId) return;

    setOptimizing(true);
    try {
      const opt = await optimizeSlideImage(file);
      setDraft((prev) => {
        if (!prev) return prev;
        const next = cloneConfig(prev);
        const target = next.slides.find((s) => s.id === slideId);
        if (target) target.imageDataUrl = opt.dataUrl;
        return next;
      });
    } catch (e) {
      toast('error', `${tr('tv.imageOptError')}: ${errorText(e)}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleAddQrCard = () => {
    if (!draft || draft.qrCards.length >= TV_LIMITS.maxQrCards) return;
    mutateDraft((next) => {
      if (next.qrCards.length >= TV_LIMITS.maxQrCards) return;
      const id = nextUniqueId(
        'qr',
        next.qrCards.map((c) => c.id),
      );
      next.qrCards.push({
        id,
        enabled: true,
        label: '',
        qrSource: 'generate',
        qrText: '',
        bgType: 'color',
        bgColor: '#161b26',
      });
    });
  };

  const handleQrCodeUpload = async (files: FileList | null) => {
    const cardId = qrCodeCardIdRef.current;
    qrCodeCardIdRef.current = null;
    const file = files?.[0];
    if (!file || !cardId) return;

    setOptimizing(true);
    try {
      const opt = await optimizeQrCodeImage(file);
      setDraft((prev) => {
        if (!prev) return prev;
        const next = cloneConfig(prev);
        const card = next.qrCards.find((c) => c.id === cardId);
        if (card) {
          card.qrSource = 'upload';
          card.qrImageDataUrl = opt.dataUrl;
        }
        return next;
      });
    } catch (e) {
      toast('error', `${tr('tv.imageOptError')}: ${errorText(e)}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleQrBgUpload = async (files: FileList | null) => {
    const cardId = qrBgCardIdRef.current;
    qrBgCardIdRef.current = null;
    const file = files?.[0];
    if (!file || !cardId) return;

    setOptimizing(true);
    try {
      const opt = await optimizeQrBgImage(file);
      setDraft((prev) => {
        if (!prev) return prev;
        const next = cloneConfig(prev);
        const card = next.qrCards.find((c) => c.id === cardId);
        if (card) {
          card.bgType = 'image';
          card.bgImageDataUrl = opt.dataUrl;
        }
        return next;
      });
    } catch (e) {
      toast('error', `${tr('tv.imageOptError')}: ${errorText(e)}`);
    } finally {
      setOptimizing(false);
    }
  };

  const getWifiDraft = (cardId: string): WifiDraft =>
    wifiDrafts[cardId] ?? { open: false, ssid: '', password: '', security: 'WPA' };

  const patchWifiDraft = (cardId: string, patch: Partial<WifiDraft>) => {
    setWifiDrafts((prev) => ({
      ...prev,
      [cardId]: { ...(prev[cardId] ?? { open: false, ssid: '', password: '', security: 'WPA' }), ...patch },
    }));
  };

  if (!draft) {
    return <div className="loading">...</div>;
  }

  const tvEndpointUrl = deriveTvConfigUrl(settings.site.url);
  const activePreviewSlide = enabledSlides[previewSlideIdx] ?? enabledSlides[0] ?? null;
  const lastPub = publishStatus?.lastResult ?? null;
  const lastPubAt = publishStatus?.lastPublishAt ?? null;
  const serverRunning = Boolean(serverStatus?.running);
  const serverClients = serverStatus?.clients ?? 0;
  const serverUrls = serverStatus?.urls ?? [];

  return (
    <div className="page tv-page">
      <div className="page-title" style={{ flexWrap: 'wrap' }}>
        <h1>{tr('tv.title')}</h1>
        <span className="dim">{tr('tv.subtitle')}</span>
        <span className="spacer" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`badge ${serverStatus?.error ? 'st-error' : serverRunning ? 'st-online' : 'st-offline'}`}>
            <span className="dot" />
            {serverRunning ? tr('tv.serverOnline') : tr('tv.serverOffline')}
          </span>
          <span className="badge" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
            {tr('tv.clientsConnected', { count: serverClients })}
          </span>
        </div>
      </div>

      {!isOwner && (
        <div className="notice warn" style={{ marginBottom: 16, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Lock size={16} />
            <div>
              <strong>{tr('role.unlockTitle')}:</strong> {tr('tv.unlockHint')}
            </div>
          </div>
          <button type="button" className="btn small" onClick={() => openUnlock(tr('tv.unlockHint'))}>
            <Lock size={13} /> {tr('tv.unlockBtn')}
          </button>
        </div>
      )}

      {/* Hidden file inputs */}
      <input
        ref={addSlideInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleAddSlidesFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={replaceSlideInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleReplaceSlideFile(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={qrCodeInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleQrCodeUpload(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={qrBgInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleQrBgUpload(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Top 2-column panel */}
      <div className="cols">
        <section className="section">
          <h2>
            <Tv size={17} /> {tr('tv.serverTitle')}
          </h2>
          <div className="hint">{tr('tv.serverDesc')}</div>

          <Option
            title={tr('tv.localServerEnabled')}
            desc={tr('tv.localServerEnabledDesc')}
            on={draft.localServerEnabled}
            onChange={(v) => mutateDraft((d) => void (d.localServerEnabled = v))}
          />

          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{tr('tv.serverPort')}</label>
              <input
                className="input mono"
                type="number"
                min={TV_LIMITS.minPort}
                max={TV_LIMITS.maxPort}
                value={draft.localServerPort}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  mutateDraft((d) => {
                    d.localServerPort = Number.isFinite(val) ? val : TV_LIMITS.minPort;
                  });
                }}
                onBlur={() => {
                  const clamped = clampInt(draft.localServerPort, TV_LIMITS.minPort, TV_LIMITS.maxPort, 7425);
                  if (clamped !== draft.localServerPort) {
                    mutateDraft((d) => void (d.localServerPort = clamped));
                  }
                }}
              />
              <span className="hint">{tr('tv.serverPortHint')}</span>
            </div>

            <div className="field">
              <label>{tr('tv.serverStatus')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, flexWrap: 'wrap' }}>
                <span className={`badge ${serverStatus?.error ? 'st-error' : serverRunning ? 'st-online' : 'st-offline'}`}>
                  <span className="dot" />
                  {serverRunning ? tr('tv.serverOnline') : tr('tv.serverOffline')}
                </span>
                <span className="badge" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                  {tr('tv.clientsConnected', { count: serverClients })}
                </span>
              </div>
            </div>
          </div>

          {serverStatus?.error && (
            <div className="errors" style={{ marginTop: 10, marginBottom: 0 }}>
              {serverStatus.error}
            </div>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <label>{tr('tv.lanUrls')}</label>
            {serverUrls.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {serverUrls.map((url) => (
                  <div
                    key={url}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 8px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-2)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <button
                      type="button"
                      className="btn ghost small mono"
                      style={{ padding: 0, height: 'auto', color: 'var(--accent)', flex: 1, justifyContent: 'flex-start', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      onClick={() => handleCopyUrl(url)}
                      title={tr('tv.copyUrl')}
                    >
                      {url}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 26, height: 26 }}
                      onClick={() => handleCopyUrl(url)}
                      title={tr('tv.copyUrl')}
                    >
                      {copiedUrl === url ? <Check size={14} color="var(--ok)" /> : <Copy size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">{tr('tv.serverNoUrls')}</div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={handleOpenPreview}>
              <ExternalLink size={15} /> {tr('tv.openPreview')}
            </button>
          </div>
        </section>

        <section className="section">
          <h2>
            <Globe size={17} /> {tr('tv.displayTitle')}
          </h2>
          <div className="hint">{tr('tv.displayDesc')}</div>

          <div className="form-grid">
            <div className="field">
              <label>{tr('tv.displayLang')}</label>
              <div>
                <Segmented<TvLang>
                  value={draft.lang}
                  options={[
                    { value: 'pl', label: 'PL' },
                    { value: 'ua', label: 'UA' },
                    { value: 'en', label: 'EN' },
                  ]}
                  onChange={(lang) => mutateDraft((d) => void (d.lang = lang))}
                />
              </div>
            </div>

            <div className="field">
              <label>{tr('tv.defaultDuration')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="input mono"
                  style={{ width: 96 }}
                  type="number"
                  min={TV_LIMITS.minDurationSec}
                  max={TV_LIMITS.maxDurationSec}
                  value={draft.defaultSlideDurationSec}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    mutateDraft((d) => {
                      d.defaultSlideDurationSec = Number.isFinite(val) ? val : TV_LIMITS.defaultDurationSec;
                    });
                  }}
                  onBlur={() => {
                    const clamped = clampInt(
                      draft.defaultSlideDurationSec,
                      TV_LIMITS.minDurationSec,
                      TV_LIMITS.maxDurationSec,
                      TV_LIMITS.defaultDurationSec,
                    );
                    if (clamped !== draft.defaultSlideDurationSec) {
                      mutateDraft((d) => void (d.defaultSlideDurationSec = clamped));
                    }
                  }}
                />
                <span className="muted">{tr('tv.secondsUnit')}</span>
              </div>
              <span className="hint">{tr('tv.defaultDurationHint')}</span>
            </div>

            <div className="field full">
              <label>{tr('tv.websiteEndpoint')}</label>
              {tvEndpointUrl ? (
                <div
                  className="mono"
                  style={{
                    padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-2)',
                    border: '1px solid var(--border)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tvEndpointUrl}
                </div>
              ) : (
                <div className="notice" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{tr('tv.websiteNotConfigured')}</span>
                  {onOpenSiteTab && (
                    <button type="button" className="btn small" onClick={onOpenSiteTab}>
                      {tr('tv.openSiteSettings')}
                    </button>
                  )}
                </div>
              )}
              {tvEndpointUrl && !settings.site.token.trim() && (
                <span className="hint" style={{ color: 'var(--warn)' }}>
                  {tr('tv.websiteTokenMissing')}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn primary"
              disabled={publishing || saving || !tvEndpointUrl}
              onClick={handlePublish}
            >
              {publishing ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
              {publishing ? tr('tv.publishingBtn') : tr('tv.publishBtn')}
            </button>

            {lastPub ? (
              <span className={`result-chip ${lastPub.ok ? 's-ok' : 's-error'}`}>
                {lastPub.ok ? <CircleCheck size={15} /> : <CircleX size={15} />}
                {lastPub.ok
                  ? lastPub.bytes
                    ? tr('tv.publishOkStatusBytes', {
                        time: lastPubAt ? fmtDateTime(lastPubAt, locale, tr('common.todayTime')) : '—',
                        kb: Math.max(1, Math.round(lastPub.bytes / 1024)),
                      })
                    : tr('tv.publishOkStatus', {
                        time: lastPubAt ? fmtDateTime(lastPubAt, locale, tr('common.todayTime')) : '—',
                      })
                  : tr('tv.publishFailStatus', { error: lastPub.error ?? `HTTP ${lastPub.status ?? ''}` })}
              </span>
            ) : (
              <span className="dim">{tr('tv.neverPublished')}</span>
            )}
          </div>
          {dirty && tvEndpointUrl && (
            <div className="hint" style={{ marginTop: 6 }}>
              {tr('tv.publishAutoSaveHint')}
            </div>
          )}
        </section>
      </div>

      {/* Live 16:9 60/40 Mini Preview Card */}
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>
            <Monitor size={17} /> {tr('tv.previewTitle')}
          </h2>
          <span className="hint" style={{ margin: 0 }}>
            {tr('tv.previewSummary', { slides: enabledSlides.length, cards: enabledCards.length })}
          </span>
          <span className="spacer" />
          {enabledSlides.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {enabledSlides.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  aria-label={tr('tv.slideNum', { num: idx + 1 })}
                  onClick={() => setPreviewSlideIdx(idx)}
                  style={{
                    width: idx === previewSlideIdx ? 18 : 8,
                    height: 8,
                    borderRadius: 99,
                    border: 0,
                    cursor: 'pointer',
                    background: idx === previewSlideIdx ? 'var(--accent)' : 'var(--border-2)',
                    transition: 'width 0.15s, background 0.15s',
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Simulated dark TV kiosk viewport (explicitly uses dark kiosk palette) */}
        <div
          style={{
            aspectRatio: '16 / 9',
            width: '100%',
            background: '#0b0e14',
            color: '#eef1f6',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border-2)',
            padding: 12,
            display: 'grid',
            gridTemplateColumns: '3fr 2fr',
            gap: 10,
            overflow: 'hidden',
          }}
        >
          {/* Left 60%: Simulated club floor map */}
          <div
            style={{
              background: '#131722',
              border: '1px solid #222a3a',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 12, letterSpacing: 0.4 }}>
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    background: '#4f8cff',
                    color: '#fff',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  V
                </span>
                <span>{tr('tv.previewMapHeader')}</span>
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 99,
                  background: 'rgba(60, 207, 130, 0.14)',
                  color: '#3ccf82',
                }}
              >
                {tr('tv.previewMapFree', { count: 5 })}
              </span>
            </div>

            <div
              style={{
                flex: 1,
                borderRadius: 6,
                border: '1px solid #1e2536',
                background: 'radial-gradient(ellipse at 50% 45%, #161c2c 0%, #10141e 80%)',
                padding: 12,
                display: 'grid',
                gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                gap: 8,
                alignContent: 'center',
              }}
            >
              {PREVIEW_PC_TILES.map((pc) => (
                <div
                  key={pc.id}
                  style={{
                    aspectRatio: '4 / 3',
                    borderRadius: 5,
                    background: '#1a2132',
                    border: `1.5px solid ${pc.occ ? '#4aa3ff' : '#3ccf82'}`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#eef1f6' }}>{pc.id}</span>
                  <span
                    style={{
                      width: 14,
                      height: 3,
                      borderRadius: 2,
                      background: pc.occ ? '#4aa3ff' : '#3ccf82',
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Right 40%: Promo banner on top + 3:4 QR cards row on bottom */}
          <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 8, minWidth: 0, minHeight: 0 }}>
            <div
              style={{
                position: 'relative',
                borderRadius: 8,
                background: '#131722',
                border: '1px solid #222a3a',
                overflow: 'hidden',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {activePreviewSlide ? (
                <>
                  <img
                    src={activePreviewSlide.imageDataUrl}
                    alt={activePreviewSlide.title ?? 'Banner'}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                  {activePreviewSlide.mode === 'with_text' && (activePreviewSlide.title || activePreviewSlide.subtitle) && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(180deg, rgba(11,14,20,0.05) 35%, rgba(11,14,20,0.88) 100%)',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        padding: '10px 12px',
                      }}
                    >
                      {activePreviewSlide.title && (
                        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, color: '#ffffff' }}>
                          {activePreviewSlide.title}
                        </div>
                      )}
                      {activePreviewSlide.subtitle && (
                        <div style={{ fontSize: 10.5, color: 'rgba(238,241,246,0.82)', marginTop: 2, lineHeight: 1.25 }}>
                          {activePreviewSlide.subtitle}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <span style={{ fontSize: 11.5, color: '#6d778b', padding: 10, textAlign: 'center' }}>{tr('tv.previewNoSlides')}</span>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${Math.max(1, enabledCards.length)}, minmax(0, 1fr))`,
                gap: 6,
                alignItems: 'center',
                minHeight: 0,
              }}
            >
              {enabledCards.length > 0 ? (
                enabledCards.map((card) => (
                  <div key={card.id} style={{ maxHeight: '100%', display: 'flex', justifyContent: 'center' }}>
                    <div style={{ width: '100%', maxWidth: 96 }}>
                      <QrCardPreview card={card} emptyText="" compact />
                    </div>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    height: '100%',
                    borderRadius: 8,
                    border: '1px dashed #252d3c',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 11,
                    color: '#6d778b',
                  }}
                >
                  {tr('tv.previewNoCards')}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Promo Banners Editor (16:9) */}
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>
            <ImagePlus size={17} /> {tr('tv.slidesTitle')}
          </h2>
          <span className="badge" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
            {tr('tv.slidesCounter', { count: draft.slides.length, max: TV_LIMITS.maxSlides })}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn small primary"
            disabled={optimizing || draft.slides.length >= TV_LIMITS.maxSlides}
            onClick={() => requireOwner(tr('tv.unlockHint'), () => addSlideInputRef.current?.click())}
          >
            {optimizing ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
            {tr('tv.addSlide')}
          </button>
        </div>
        <div className="hint">{tr('tv.slidesHint')}</div>

        {draft.slides.length === 0 ? (
          <div
            className="dim"
            style={{
              padding: 20,
              borderRadius: 'var(--radius-sm)',
              border: '1px dashed var(--border-2)',
              textAlign: 'center',
            }}
          >
            {tr('tv.slidesEmpty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draft.slides.map((slide, idx) => {
              const sizeKb = kbOf(slide.imageDataUrl);
              return (
                <div
                  key={slide.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(210px, 260px) minmax(0, 1fr)',
                    gap: 14,
                    padding: 12,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    opacity: slide.enabled ? 1 : 0.72,
                  }}
                >
                  <div>
                    <div
                      style={{
                        position: 'relative',
                        aspectRatio: '16 / 9',
                        width: '100%',
                        borderRadius: 'var(--radius-sm)',
                        overflow: 'hidden',
                        border: '1px solid var(--border-2)',
                        background: 'var(--bg-2)',
                      }}
                    >
                      {slide.imageDataUrl && (
                        <img
                          src={slide.imageDataUrl}
                          alt={slide.title || tr('tv.slideNum', { num: idx + 1 })}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      )}
                      {slide.mode === 'with_text' && (slide.title || slide.subtitle) && (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'linear-gradient(180deg, rgba(11,14,20,0.05) 35%, rgba(11,14,20,0.88) 100%)',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'flex-end',
                            padding: 8,
                            color: '#ffffff',
                          }}
                        >
                          {slide.title && <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>{slide.title}</div>}
                          {slide.subtitle && (
                            <div style={{ fontSize: 10, color: 'rgba(238,241,246,0.84)', marginTop: 2, lineHeight: 1.2 }}>
                              {slide.subtitle}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 6 }}>
                      <span className="badge mono" style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                        {tr('tv.imageSizeKb', { kb: sizeKb })}
                      </span>
                      <button
                        type="button"
                        className="btn small"
                        disabled={optimizing}
                        onClick={() =>
                          requireOwner(tr('tv.unlockHint'), () => {
                            replaceSlideIdRef.current = slide.id;
                            replaceSlideInputRef.current?.click();
                          })
                        }
                      >
                        <RefreshCw size={13} /> {tr('tv.slideReplaceImage')}
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{tr('tv.slideNum', { num: idx + 1 })}</strong>
                      <span className="spacer" />
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
                        <span>{tr('tv.slideEnabled')}</span>
                        <Switch
                          on={slide.enabled}
                          label={tr('tv.slideEnabled')}
                          onChange={(v) =>
                            mutateDraft((d) => {
                              const item = d.slides.find((x) => x.id === slide.id);
                              if (item) item.enabled = v;
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === 0}
                        title={tr('tv.slideMoveUp')}
                        onClick={() => mutateDraft((d) => void (d.slides = moveItem(d.slides, idx, idx - 1)))}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === draft.slides.length - 1}
                        title={tr('tv.slideMoveDown')}
                        onClick={() => mutateDraft((d) => void (d.slides = moveItem(d.slides, idx, idx + 1)))}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        style={{ color: 'var(--err)' }}
                        title={tr('tv.slideDelete')}
                        onClick={() => mutateDraft((d) => void (d.slides = d.slides.filter((x) => x.id !== slide.id)))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="form-grid">
                      <div className="field">
                        <label>{tr('tv.slideMode')}</label>
                        <div>
                          <Segmented<TvSlideMode>
                            value={slide.mode}
                            options={[
                              { value: 'image_only', label: tr('tv.slideModeImageOnly') },
                              { value: 'with_text', label: tr('tv.slideModeWithText') },
                            ]}
                            onChange={(mode) =>
                              mutateDraft((d) => {
                                const item = d.slides.find((x) => x.id === slide.id);
                                if (item) item.mode = mode;
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="field">
                        <label>{tr('tv.slideDuration')}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            className="input mono"
                            style={{ width: 96 }}
                            type="number"
                            min={TV_LIMITS.minDurationSec}
                            max={TV_LIMITS.maxDurationSec}
                            placeholder={String(draft.defaultSlideDurationSec)}
                            value={slide.durationSec ?? ''}
                            onChange={(e) => {
                              const raw = e.target.value.trim();
                              mutateDraft((d) => {
                                const item = d.slides.find((x) => x.id === slide.id);
                                if (!item) return;
                                if (!raw) delete item.durationSec;
                                else item.durationSec = Number(raw);
                              });
                            }}
                            onBlur={() => {
                              if (slide.durationSec === undefined) return;
                              const clamped = clampInt(
                                slide.durationSec,
                                TV_LIMITS.minDurationSec,
                                TV_LIMITS.maxDurationSec,
                                draft.defaultSlideDurationSec,
                              );
                              if (clamped !== slide.durationSec) {
                                mutateDraft((d) => {
                                  const item = d.slides.find((x) => x.id === slide.id);
                                  if (item) item.durationSec = clamped;
                                });
                              }
                            }}
                          />
                          <span className="muted">{tr('tv.secondsUnit')}</span>
                        </div>
                      </div>

                      <div className="field">
                        <label>{tr('tv.slideTitle')}</label>
                        <input
                          className="input"
                          maxLength={120}
                          disabled={slide.mode !== 'with_text'}
                          placeholder={tr('tv.slideTitlePlaceholder')}
                          value={slide.title ?? ''}
                          onChange={(e) =>
                            mutateDraft((d) => {
                              const item = d.slides.find((x) => x.id === slide.id);
                              if (item) item.title = e.target.value;
                            })
                          }
                        />
                      </div>

                      <div className="field">
                        <label>{tr('tv.slideSubtitle')}</label>
                        <input
                          className="input"
                          maxLength={220}
                          disabled={slide.mode !== 'with_text'}
                          placeholder={tr('tv.slideSubtitlePlaceholder')}
                          value={slide.subtitle ?? ''}
                          onChange={(e) =>
                            mutateDraft((d) => {
                              const item = d.slides.find((x) => x.id === slide.id);
                              if (item) item.subtitle = e.target.value;
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* QR Cards Editor (3:4) */}
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>
            <QrCode size={17} /> {tr('tv.qrTitle')}
          </h2>
          <span className="badge" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
            {tr('tv.qrCounter', { count: draft.qrCards.length, max: TV_LIMITS.maxQrCards })}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn small primary"
            disabled={draft.qrCards.length >= TV_LIMITS.maxQrCards}
            onClick={handleAddQrCard}
          >
            <Plus size={14} /> {tr('tv.addQrCard')}
          </button>
        </div>
        <div className="hint">{tr('tv.qrHint')}</div>

        {draft.qrCards.length === 0 ? (
          <div
            className="dim"
            style={{
              padding: 20,
              borderRadius: 'var(--radius-sm)',
              border: '1px dashed var(--border-2)',
              textAlign: 'center',
            }}
          >
            {tr('tv.qrEmpty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draft.qrCards.map((card, idx) => {
              const wifi = getWifiDraft(card.id);
              const qrStatus = card.qrSource === 'generate' ? safeQrDataUrl(card.qrText ?? '') : { dataUrl: card.qrImageDataUrl ?? null, tooLong: false };
              return (
                <div
                  key={card.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '148px minmax(0, 1fr)',
                    gap: 16,
                    padding: 12,
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--panel-2)',
                    border: '1px solid var(--border)',
                    opacity: card.enabled ? 1 : 0.72,
                    alignItems: 'start',
                  }}
                >
                  <QrCardPreview card={card} emptyText={tr('tv.qrPreviewEmpty')} />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{tr('tv.qrCardNum', { num: idx + 1 })}</strong>
                      <span className="spacer" />
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
                        <span>{tr('tv.qrEnabled')}</span>
                        <Switch
                          on={card.enabled}
                          label={tr('tv.qrEnabled')}
                          onChange={(v) =>
                            mutateDraft((d) => {
                              const item = d.qrCards.find((x) => x.id === card.id);
                              if (item) item.enabled = v;
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === 0}
                        title={tr('tv.qrMovePrev')}
                        onClick={() => mutateDraft((d) => void (d.qrCards = moveItem(d.qrCards, idx, idx - 1)))}
                      >
                        <ArrowLeft size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        disabled={idx === draft.qrCards.length - 1}
                        title={tr('tv.qrMoveNext')}
                        onClick={() => mutateDraft((d) => void (d.qrCards = moveItem(d.qrCards, idx, idx + 1)))}
                      >
                        <ArrowRight size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        style={{ color: 'var(--err)' }}
                        title={tr('tv.qrDelete')}
                        onClick={() => mutateDraft((d) => void (d.qrCards = d.qrCards.filter((x) => x.id !== card.id)))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="form-grid">
                      <div className="field">
                        <label>{tr('tv.qrLabel')}</label>
                        <input
                          className="input"
                          maxLength={40}
                          placeholder={tr('tv.qrLabelPlaceholder')}
                          value={card.label}
                          onChange={(e) =>
                            mutateDraft((d) => {
                              const item = d.qrCards.find((x) => x.id === card.id);
                              if (item) item.label = e.target.value;
                            })
                          }
                        />
                      </div>

                      <div className="field">
                        <label>{tr('tv.qrSublabel')}</label>
                        <input
                          className="input"
                          maxLength={60}
                          placeholder={tr('tv.qrSublabelPlaceholder')}
                          value={card.sublabel ?? ''}
                          onChange={(e) =>
                            mutateDraft((d) => {
                              const item = d.qrCards.find((x) => x.id === card.id);
                              if (item) item.sublabel = e.target.value;
                            })
                          }
                        />
                      </div>

                      <div className="field full">
                        <label>{tr('tv.qrSource')}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <Segmented<TvQrSource>
                            value={card.qrSource}
                            options={[
                              { value: 'generate', label: tr('tv.qrSourceGenerate') },
                              { value: 'upload', label: tr('tv.qrSourceUpload') },
                            ]}
                            onChange={(src) =>
                              mutateDraft((d) => {
                                const item = d.qrCards.find((x) => x.id === card.id);
                                if (item) item.qrSource = src;
                              })
                            }
                          />

                          {card.qrSource === 'generate' && (
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => patchWifiDraft(card.id, { open: !wifi.open })}
                            >
                              <Wifi size={14} /> {tr('tv.wifiToggle')}
                            </button>
                          )}
                        </div>
                      </div>

                      {card.qrSource === 'generate' ? (
                        <div className="field full">
                          <label>{tr('tv.qrText')}</label>
                          <input
                            className="input mono"
                            maxLength={500}
                            spellCheck={false}
                            placeholder={tr('tv.qrTextPlaceholder')}
                            value={card.qrText ?? ''}
                            onChange={(e) =>
                              mutateDraft((d) => {
                                const item = d.qrCards.find((x) => x.id === card.id);
                                if (item) item.qrText = e.target.value;
                              })
                            }
                          />
                          {qrStatus.tooLong && (
                            <span className="hint" style={{ color: 'var(--err)' }}>
                              {tr('tv.qrTooLong')}
                            </span>
                          )}

                          {wifi.open && (
                            <div
                              style={{
                                marginTop: 8,
                                padding: 10,
                                borderRadius: 'var(--radius-sm)',
                                background: 'var(--panel)',
                                border: '1px solid var(--border-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 10,
                              }}
                            >
                              <div className="form-grid">
                                <div className="field">
                                  <label>{tr('tv.wifiSsid')}</label>
                                  <input
                                    className="input"
                                    placeholder={tr('tv.wifiSsidPlaceholder')}
                                    value={wifi.ssid}
                                    onChange={(e) => patchWifiDraft(card.id, { ssid: e.target.value })}
                                  />
                                </div>
                                <div className="field">
                                  <label>{tr('tv.wifiPassword')}</label>
                                  <input
                                    className="input"
                                    disabled={wifi.security === 'nopass'}
                                    placeholder={tr('tv.wifiPasswordPlaceholder')}
                                    value={wifi.password}
                                    onChange={(e) => patchWifiDraft(card.id, { password: e.target.value })}
                                  />
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span className="hint">{tr('tv.wifiSecurity')}:</span>
                                  <Segmented<WifiSecurity>
                                    value={wifi.security}
                                    options={[
                                      { value: 'WPA', label: tr('tv.wifiSecWpa') },
                                      { value: 'WEP', label: tr('tv.wifiSecWep') },
                                      { value: 'nopass', label: tr('tv.wifiSecNopass') },
                                    ]}
                                    onChange={(security) => patchWifiDraft(card.id, { security })}
                                  />
                                </div>
                                <button
                                  type="button"
                                  className="btn small primary"
                                  disabled={!wifi.ssid.trim()}
                                  onClick={() => {
                                    const payload = buildWifiQrString(wifi.ssid.trim(), wifi.password, wifi.security);
                                    mutateDraft((d) => {
                                      const item = d.qrCards.find((x) => x.id === card.id);
                                      if (!item) return;
                                      item.qrSource = 'generate';
                                      item.qrText = payload;
                                    });
                                    patchWifiDraft(card.id, { open: false });
                                  }}
                                >
                                  {tr('tv.wifiApply')}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="field full">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn small"
                              disabled={optimizing}
                              onClick={() =>
                                requireOwner(tr('tv.unlockHint'), () => {
                                  qrCodeCardIdRef.current = card.id;
                                  qrCodeInputRef.current?.click();
                                })
                              }
                            >
                              <Upload size={14} /> {tr('tv.qrUploadBtn')}
                            </button>
                            {card.qrImageDataUrl ? (
                              <span className="badge mono" style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                                {tr('tv.imageSizeKb', { kb: kbOf(card.qrImageDataUrl) })}
                              </span>
                            ) : (
                              <span className="hint">{tr('tv.qrNoImage')}</span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="field full">
                        <label>{tr('tv.qrBgType')}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <Segmented<TvQrBgType>
                            value={card.bgType}
                            options={[
                              { value: 'color', label: tr('tv.qrBgColor') },
                              { value: 'image', label: tr('tv.qrBgImage') },
                            ]}
                            onChange={(bgType) =>
                              mutateDraft((d) => {
                                const item = d.qrCards.find((x) => x.id === card.id);
                                if (item) item.bgType = bgType;
                              })
                            }
                          />

                          {card.bgType === 'color' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <input
                                type="color"
                                value={card.bgColor || '#161b26'}
                                onChange={(e) =>
                                  mutateDraft((d) => {
                                    const item = d.qrCards.find((x) => x.id === card.id);
                                    if (item) item.bgColor = e.target.value;
                                  })
                                }
                                style={{
                                  width: 34,
                                  height: 28,
                                  padding: 2,
                                  borderRadius: 'var(--radius-sm)',
                                  border: '1px solid var(--border-2)',
                                  background: 'var(--bg-2)',
                                  cursor: 'pointer',
                                }}
                              />
                              <span className="mono muted">{card.bgColor}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                {QR_BG_PRESETS.map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    title={preset}
                                    onClick={() =>
                                      mutateDraft((d) => {
                                        const item = d.qrCards.find((x) => x.id === card.id);
                                        if (item) item.bgColor = preset;
                                      })
                                    }
                                    style={{
                                      width: 22,
                                      height: 22,
                                      borderRadius: 6,
                                      background: preset,
                                      border: card.bgColor.toLowerCase() === preset ? '2px solid var(--accent)' : '1px solid var(--border-2)',
                                      cursor: 'pointer',
                                      padding: 0,
                                    }}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn small"
                                disabled={optimizing}
                                onClick={() =>
                                  requireOwner(tr('tv.unlockHint'), () => {
                                    qrBgCardIdRef.current = card.id;
                                    qrBgInputRef.current?.click();
                                  })
                                }
                              >
                                <Upload size={14} /> {tr('tv.qrBgUploadBtn')}
                              </button>
                              {card.bgImageDataUrl && (
                                <span className="badge mono" style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                                  {tr('tv.imageSizeKb', { kb: kbOf(card.bgImageDataUrl) })}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <SaveBar dirty={dirty} saving={saving} onSave={handleSave} onReset={handleReset} />
    </div>
  );
}
