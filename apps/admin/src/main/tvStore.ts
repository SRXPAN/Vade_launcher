import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultTvConfig,
  sanitizeTvConfig,
  type TvDisplayConfig,
  type TvQrCard,
  type TvSlide,
} from '@vade/protocol';

const ASSET_FILENAME_RE = /^[a-f0-9]{16}\.(webp|jpg|jpeg|png|svg)$/i;
const ASSET_REF_RE = /^@asset:([a-f0-9]{16}\.(?:webp|jpg|jpeg|png|svg))$/i;
const LOCAL_ASSET_URL_RE = /^\/tv-assets\/([a-f0-9]{16}\.(?:webp|jpg|jpeg|png|svg))$/i;
const DATA_IMAGE_RE = /^data:image\/(webp|jpeg|jpg|png|svg\+xml);base64,([A-Za-z0-9+/=]+)$/i;

const EXT_BY_SUBTYPE: Record<string, string> = {
  webp: 'webp',
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  'svg+xml': 'svg',
};

const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
};

function writeAtomicWithBak(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

function writeAssetAtomic(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return;
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Converts `@asset:<file>` references into `/tv-assets/<file>` so `sanitizeTvConfig` accepts them. */
export function preprocessTvRefsForSanitize(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const mapRef = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const m = ASSET_REF_RE.exec(v.trim());
    return m ? `/tv-assets/${m[1].toLowerCase()}` : v;
  };
  return {
    ...src,
    slides: Array.isArray(src.slides)
      ? src.slides.map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? { ...(item as Record<string, unknown>), imageDataUrl: mapRef((item as Record<string, unknown>).imageDataUrl) }
            : item,
        )
      : src.slides,
    qrCards: Array.isArray(src.qrCards)
      ? src.qrCards.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const card = item as Record<string, unknown>;
          return {
            ...card,
            qrImageDataUrl: mapRef(card.qrImageDataUrl),
            bgImageDataUrl: mapRef(card.bgImageDataUrl),
          };
        })
      : src.qrCards,
  };
}

/**
 * Persists TV kiosk display configuration in `<dataDir>/tv-config.json` and extracts
 * embedded base64 images into content-addressed files under `<dataDir>/tv-assets/`.
 */
export class TvStore {
  readonly configFile: string;
  readonly assetsDir: string;
  private storedConfig: TvDisplayConfig;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.configFile = path.join(dataDir, 'tv-config.json');
    this.assetsDir = path.join(dataDir, 'tv-assets');
    this.storedConfig = defaultTvConfig();
    this.reloadFromDisk();
  }

  /** Reloads `tv-config.json` (falling back to `.bak` or defaults) without modifying disk. */
  reloadFromDisk(): TvDisplayConfig {
    const raw = readJsonSafe(this.configFile) ?? readJsonSafe(`${this.configFile}.bak`);
    if (!raw) {
      this.storedConfig = defaultTvConfig();
      return this.getHydratedConfig();
    }
    const sanitized = sanitizeTvConfig(preprocessTvRefsForSanitize(raw), defaultTvConfig());
    this.storedConfig = this.mapConfigImages(sanitized, (ref) => {
      const localMatch = LOCAL_ASSET_URL_RE.exec(ref);
      return localMatch ? `@asset:${localMatch[1].toLowerCase()}` : ref;
    });
    return this.getHydratedConfig();
  }

  /**
   * Sanitizes and saves a TV display config, extracting data-URI images into `tv-assets/`,
   * pruning unreferenced asset files, and updating `updatedAt`. Returns the hydrated config.
   */
  save(rawCfg: unknown): TvDisplayConfig {
    const sanitized = sanitizeTvConfig(preprocessTvRefsForSanitize(rawCfg), defaultTvConfig());
    sanitized.updatedAt = Date.now();

    const referenced = new Set<string>();
    const stored = this.mapConfigImages(sanitized, (ref) => {
      const dataMatch = DATA_IMAGE_RE.exec(ref);
      if (dataMatch) {
        const subtype = dataMatch[1].toLowerCase();
        const ext = EXT_BY_SUBTYPE[subtype];
        const bytes = Buffer.from(dataMatch[2], 'base64');
        if (!ext || bytes.length === 0) return '';
        const hash16 = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const filename = `${hash16}.${ext}`;
        writeAssetAtomic(path.join(this.assetsDir, filename), bytes);
        referenced.add(filename);
        return `@asset:${filename}`;
      }

      const localMatch = LOCAL_ASSET_URL_RE.exec(ref);
      if (localMatch) {
        const filename = localMatch[1].toLowerCase();
        if (this.resolveAsset(filename)) {
          referenced.add(filename);
          return `@asset:${filename}`;
        }
        return '';
      }

      return '';
    });

    this.storedConfig = stored;
    writeAtomicWithBak(this.configFile, JSON.stringify(stored, null, 2));
    this.pruneOrphanedAssets(referenced);
    return this.getHydratedConfig();
  }

  /** Returns the config with `@asset:<file>` references hydrated back into `data:image/...;base64,...`. */
  getHydratedConfig(): TvDisplayConfig {
    return this.mapConfigImages(this.storedConfig, (ref) => {
      const m = ASSET_REF_RE.exec(ref);
      if (!m) return ref;
      const resolved = this.resolveAsset(m[1].toLowerCase());
      if (!resolved) return '';
      try {
        const b64 = fs.readFileSync(resolved.filePath).toString('base64');
        return `data:${resolved.contentType};base64,${b64}`;
      } catch {
        return '';
      }
    });
  }

  /** Returns the config with `@asset:<file>` references mapped to `/tv-assets/<file>` for the local HTTP server. */
  getLocalServedConfig(): TvDisplayConfig {
    return this.mapConfigImages(this.storedConfig, (ref) => {
      const m = ASSET_REF_RE.exec(ref);
      if (!m) return ref;
      const filename = m[1].toLowerCase();
      return this.resolveAsset(filename) ? `/tv-assets/${filename}` : '';
    });
  }

  /** Resolves a validated content-addressed asset filename to its disk path and MIME type. */
  resolveAsset(filename: string): { filePath: string; contentType: string } | null {
    if (typeof filename !== 'string' || !ASSET_FILENAME_RE.test(filename)) return null;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType = MIME_BY_EXT[ext];
    if (!contentType) return null;

    const assetsRoot = path.resolve(this.assetsDir);
    const filePath = path.resolve(assetsRoot, filename);
    if (path.dirname(filePath) !== assetsRoot) return null;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      return { filePath, contentType };
    } catch {
      return null;
    }
  }

  private mapConfigImages(cfg: TvDisplayConfig, transform: (val: string) => string): TvDisplayConfig {
    const slides: TvSlide[] = cfg.slides.map((s) => ({
      ...s,
      imageDataUrl: s.imageDataUrl ? transform(s.imageDataUrl.trim()) : '',
    }));

    const qrCards: TvQrCard[] = cfg.qrCards.map((c) => {
      const next: TvQrCard = {
        id: c.id,
        enabled: c.enabled,
        label: c.label,
        ...(c.sublabel ? { sublabel: c.sublabel } : {}),
        qrSource: c.qrSource,
        ...(c.qrText ? { qrText: c.qrText } : {}),
        bgType: c.bgType,
        bgColor: c.bgColor,
      };
      if (c.qrImageDataUrl) {
        const mapped = transform(c.qrImageDataUrl.trim());
        if (mapped) next.qrImageDataUrl = mapped;
      }
      if (c.bgImageDataUrl) {
        const mapped = transform(c.bgImageDataUrl.trim());
        if (mapped) next.bgImageDataUrl = mapped;
      }
      return next;
    });

    return {
      updatedAt: cfg.updatedAt,
      lang: cfg.lang,
      defaultSlideDurationSec: cfg.defaultSlideDurationSec,
      localServerEnabled: cfg.localServerEnabled,
      localServerPort: cfg.localServerPort,
      slides,
      qrCards,
    };
  }

  private pruneOrphanedAssets(referenced: Set<string>): void {
    if (!fs.existsSync(this.assetsDir)) return;
    try {
      for (const entry of fs.readdirSync(this.assetsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (referenced.has(entry.name.toLowerCase())) continue;
        try {
          fs.unlinkSync(path.join(this.assetsDir, entry.name));
        } catch {
          // Skip locked files; future saves can prune them.
        }
      }
    } catch {
      // Directory unreadable; ignore cleanup failure.
    }
  }
}
