import { TV_LIMITS } from './defaults';
import type { TvDisplayConfig, TvLang, TvQrBgType, TvQrCard, TvQrSource, TvSlide, TvSlideMode } from './types';

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:webp|jpeg|jpg|png|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;
const SAFE_LOCAL_ASSET_RE = /^\/tv-assets\/[a-f0-9]{16}\.(?:webp|jpg|jpeg|png|svg)$/i;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Checks whether a TV banner or QR image reference is a safe base64 data URI or local /tv-assets/ path. */
export function isSafeTvImageRef(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > TV_LIMITS.maxDataUrlBytes) return false;
  return SAFE_DATA_IMAGE_RE.test(trimmed) || SAFE_LOCAL_ASSET_RE.test(trimmed);
}

function normalizeLang(v: unknown, fallback: TvLang = 'pl'): TvLang {
  if (v === 'pl' || v === 'ua' || v === 'en') return v;
  if (v === 'uk') return 'ua';
  return fallback;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanUniqueId(raw: unknown, used: Set<string>, prefix: string): string {
  let id = typeof raw === 'string' ? raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) : '';
  if (!id || used.has(id)) {
    let n = used.size + 1;
    while (used.has(`${prefix}-${n}`)) n++;
    id = `${prefix}-${n}`;
  }
  used.add(id);
  return id;
}

/** Normalises and bounds an untrusted TvDisplayConfig payload before saving, serving, or publishing. */
export function sanitizeTvConfig(raw: unknown, fallback?: TvDisplayConfig): TvDisplayConfig {
  const base: TvDisplayConfig = fallback ?? {
    updatedAt: 0,
    lang: 'pl',
    defaultSlideDurationSec: TV_LIMITS.defaultDurationSec,
    localServerEnabled: true,
    localServerPort: 7425,
    slides: [],
    qrCards: [],
  };
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const updatedAtRaw = Number(src.updatedAt);
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw >= 0 ? Math.floor(updatedAtRaw) : base.updatedAt;
  const lang = normalizeLang(src.lang, base.lang);
  const defaultSlideDurationSec = clampInt(
    src.defaultSlideDurationSec,
    TV_LIMITS.minDurationSec,
    TV_LIMITS.maxDurationSec,
    base.defaultSlideDurationSec,
  );
  const localServerEnabled = typeof src.localServerEnabled === 'boolean' ? src.localServerEnabled : base.localServerEnabled;
  const localServerPort = clampInt(src.localServerPort, TV_LIMITS.minPort, TV_LIMITS.maxPort, base.localServerPort);

  const slideIds = new Set<string>();
  const slides: TvSlide[] = [];
  const rawSlides = Array.isArray(src.slides) ? src.slides : base.slides;
  for (const item of rawSlides) {
    if (slides.length >= TV_LIMITS.maxSlides) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const imageDataUrl = isSafeTvImageRef(s.imageDataUrl) ? s.imageDataUrl.trim() : '';
    const mode: TvSlideMode = s.mode === 'with_text' ? 'with_text' : 'image_only';
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 120) : '';
    const subtitle = typeof s.subtitle === 'string' ? s.subtitle.trim().slice(0, 220) : '';
    const durationSec =
      s.durationSec != null && s.durationSec !== ''
        ? clampInt(s.durationSec, TV_LIMITS.minDurationSec, TV_LIMITS.maxDurationSec, defaultSlideDurationSec)
        : undefined;
    slides.push({
      id: cleanUniqueId(s.id, slideIds, 'slide'),
      enabled: s.enabled !== false,
      imageDataUrl,
      mode,
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
    });
  }

  const cardIds = new Set<string>();
  const qrCards: TvQrCard[] = [];
  const rawCards = Array.isArray(src.qrCards) ? src.qrCards : base.qrCards;
  for (const item of rawCards) {
    if (qrCards.length >= TV_LIMITS.maxQrCards) break;
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const label = typeof c.label === 'string' ? c.label.trim().slice(0, 40) : '';
    const sublabel = typeof c.sublabel === 'string' ? c.sublabel.trim().slice(0, 60) : '';
    const qrSource: TvQrSource = c.qrSource === 'upload' ? 'upload' : 'generate';
    const qrText = typeof c.qrText === 'string' ? c.qrText.trim().slice(0, 500) : '';
    const qrImageDataUrl = isSafeTvImageRef(c.qrImageDataUrl) ? c.qrImageDataUrl.trim() : undefined;
    const bgType: TvQrBgType = c.bgType === 'image' ? 'image' : 'color';
    const bgColorRaw = typeof c.bgColor === 'string' ? c.bgColor.trim() : '';
    const bgColor = HEX_COLOR_RE.test(bgColorRaw) ? bgColorRaw.toLowerCase() : '#161b26';
    const bgImageDataUrl = isSafeTvImageRef(c.bgImageDataUrl) ? c.bgImageDataUrl.trim() : undefined;
    qrCards.push({
      id: cleanUniqueId(c.id, cardIds, 'qr'),
      enabled: c.enabled !== false,
      label,
      ...(sublabel ? { sublabel } : {}),
      qrSource,
      ...(qrText ? { qrText } : {}),
      ...(qrImageDataUrl ? { qrImageDataUrl } : {}),
      bgType,
      bgColor,
      ...(bgImageDataUrl ? { bgImageDataUrl } : {}),
    });
  }

  return {
    updatedAt,
    lang,
    defaultSlideDurationSec,
    localServerEnabled,
    localServerPort,
    slides,
    qrCards,
  };
}

/** Derives the club website TV config endpoint (/api/tv-config) from the configured site webhook URL. */
export function deriveTvConfigUrl(siteStatusUrl: string): string | null {
  const raw = String(siteStatusUrl ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/\/api\/[^/]*$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/api\/[^/]*$/i, '/api/tv-config');
    } else {
      u.pathname = '/api/tv-config';
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
