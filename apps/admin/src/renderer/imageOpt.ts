export interface OptimizedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';

const SLIDE_MAX_W = 1920;
const SLIDE_MAX_H = 1080;
const SLIDE_TARGET_BYTES = 220 * 1024;
const SLIDE_QUALITIES = [0.82, 0.72, 0.6, 0.5];

const QR_BG_W = 480;
const QR_BG_H = 640;
const QR_BG_TARGET_BYTES = 65 * 1024;
const QR_BG_QUALITIES = [0.82, 0.72, 0.6, 0.5];

const QR_CODE_MAX = 360;

interface DecodedSource {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) => void;
  close: () => void;
}

/** Estimates the decoded payload size (in bytes) of a data URL. */
export function estimateDataUrlBytes(dataUrl: string): number {
  if (!dataUrl) return 0;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl.length;
  const header = dataUrl.slice(0, comma).toLowerCase();
  const body = dataUrl.slice(comma + 1);
  if (header.includes(';base64')) {
    const clean = body.replace(/\s+/g, '');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).length;
  } catch {
    return body.length;
  }
}

/** Escapes special Wi-Fi QR characters (\ ; , :) and builds a standard WIFI: payload string. */
export function buildWifiQrString(ssid: string, password: string, security: WifiSecurity): string {
  const esc = (v: string) => v.replace(/([\\;,:])/g, '\\$1');
  const safeSsid = esc(ssid);
  if (security === 'nopass') {
    return `WIFI:T:nopass;S:${safeSsid};;`;
  }
  return `WIFI:T:${security};S:${safeSsid};P:${esc(password)};;`;
}

async function decodeImageFile(file: File): Promise<DecodedSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width > 0 && bmp.height > 0) {
        return {
          width: bmp.width,
          height: bmp.height,
          draw: (ctx, sx, sy, sw, sh, dw, dh) => ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh),
          close: () => bmp.close(),
        };
      }
      bmp.close();
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image'));
      el.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width <= 0 || height <= 0) {
      throw new Error('Image has invalid dimensions');
    }
    return {
      width,
      height,
      draw: (ctx, sx, sy, sw, sh, dw, dh) => ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return { canvas, ctx };
}

function encodeLossy(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
}

function encodeIterative(
  src: DecodedSource,
  crop: { sx: number; sy: number; sw: number; sh: number },
  baseW: number,
  baseH: number,
  qualities: readonly number[],
  targetBytes: number,
  shrinkSteps: readonly number[],
  minDim: number,
): OptimizedImage {
  let best: OptimizedImage | null = null;

  for (const scale of shrinkSteps) {
    const w = Math.max(minDim, Math.round(baseW * scale));
    const h = Math.max(minDim, Math.round(baseH * scale));
    const { canvas, ctx } = createCanvas(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    src.draw(ctx, crop.sx, crop.sy, crop.sw, crop.sh, canvas.width, canvas.height);

    const stepQualities = scale === 1 ? qualities : qualities.slice(1);
    for (const q of stepQualities) {
      const dataUrl = encodeLossy(canvas, q);
      const bytes = estimateDataUrlBytes(dataUrl);
      const candidate: OptimizedImage = { dataUrl, width: canvas.width, height: canvas.height, bytes };
      if (!best || bytes < best.bytes) best = candidate;
      if (bytes <= targetBytes) return candidate;
    }
  }

  return best!;
}

/** Scales a promo slide proportionally up to 1920x1080 and compresses to <= 220 KB (WebP/JPEG). */
export async function optimizeSlideImage(file: File): Promise<OptimizedImage> {
  const src = await decodeImageFile(file);
  try {
    const scale = Math.min(1, SLIDE_MAX_W / src.width, SLIDE_MAX_H / src.height);
    const targetW = Math.max(1, Math.round(src.width * scale));
    const targetH = Math.max(1, Math.round(src.height * scale));
    return encodeIterative(
      src,
      { sx: 0, sy: 0, sw: src.width, sh: src.height },
      targetW,
      targetH,
      SLIDE_QUALITIES,
      SLIDE_TARGET_BYTES,
      [1, 0.85, 0.72, 0.6],
      320,
    );
  } finally {
    src.close();
  }
}

/** Center-crops a QR card background to 3:4 up to 480x640 and compresses to <= 65 KB (WebP/JPEG). */
export async function optimizeQrBgImage(file: File): Promise<OptimizedImage> {
  const src = await decodeImageFile(file);
  try {
    const targetRatio = QR_BG_W / QR_BG_H;
    const srcRatio = src.width / src.height;
    let sx = 0;
    let sy = 0;
    let sw = src.width;
    let sh = src.height;

    if (srcRatio > targetRatio) {
      sw = src.height * targetRatio;
      sx = (src.width - sw) / 2;
    } else if (srcRatio < targetRatio) {
      sh = src.width / targetRatio;
      sy = (src.height - sh) / 2;
    }

    const baseW = Math.min(QR_BG_W, Math.max(120, Math.round(sw)));
    const baseH = Math.max(160, Math.round((baseW * 4) / 3));
    return encodeIterative(
      src,
      { sx, sy, sw, sh },
      baseW,
      baseH,
      QR_BG_QUALITIES,
      QR_BG_TARGET_BYTES,
      [1, 0.82, 0.68],
      120,
    );
  } finally {
    src.close();
  }
}

/** Scales an uploaded QR code image up to 360x360 while preserving crisp high-contrast edges. */
export async function optimizeQrCodeImage(file: File): Promise<OptimizedImage> {
  const src = await decodeImageFile(file);
  try {
    const maxSrc = Math.max(src.width, src.height);
    let targetW: number;
    let targetH: number;
    let smooth: boolean;

    if (maxSrc < 180) {
      const intScale = Math.max(1, Math.floor(QR_CODE_MAX / maxSrc));
      targetW = src.width * intScale;
      targetH = src.height * intScale;
      smooth = false;
    } else {
      const scale = Math.min(1, QR_CODE_MAX / src.width, QR_CODE_MAX / src.height);
      targetW = Math.max(1, Math.round(src.width * scale));
      targetH = Math.max(1, Math.round(src.height * scale));
      smooth = maxSrc > QR_CODE_MAX * 2;
    }

    const { canvas, ctx } = createCanvas(targetW, targetH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    src.draw(ctx, 0, 0, src.width, src.height, canvas.width, canvas.height);

    const pngUrl = canvas.toDataURL('image/png');
    const pngBytes = estimateDataUrlBytes(pngUrl);
    if (pngBytes <= 140 * 1024) {
      return { dataUrl: pngUrl, width: canvas.width, height: canvas.height, bytes: pngBytes };
    }

    const webpUrl = canvas.toDataURL('image/webp', 0.95);
    const dataUrl = webpUrl.startsWith('data:image/webp') ? webpUrl : pngUrl;
    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      bytes: estimateDataUrlBytes(dataUrl),
    };
  } finally {
    src.close();
  }
}
