import { nativeImage, type NativeImage } from 'electron';

/** Draws the app icon (blue rounded square with a white "V") so no binary asset is needed. */
export function appIcon(size = 32): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.24;
  const t = size * 0.085;
  const a = { x: size * 0.27, y: size * 0.3 };
  const b = { x: size * 0.5, y: size * 0.73 };
  const c = { x: size * 0.73, y: size * 0.3 };
  const distToSeg = (px: number, py: number, p: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const k = Math.max(0, Math.min(1, ((px - p.x) * dx + (py - p.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (p.x + k * dx), py - (p.y + k * dy));
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cx = Math.min(Math.max(px, r), size - r);
      const cy = Math.min(Math.max(py, r), size - r);
      const outside = Math.hypot(px - cx, py - cy) - r;
      const alpha = Math.max(0, Math.min(1, 0.5 - outside));
      if (alpha <= 0) continue;
      const d = Math.min(distToSeg(px, py, a, b), distToSeg(px, py, c, b));
      const w = Math.max(0, Math.min(1, t - d + 0.5));
      // background #3b7bff -> white stroke
      const R = Math.round(59 + (255 - 59) * w);
      const G = Math.round(123 + (255 - 123) * w);
      const B = 255;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(B * alpha);
      buf[i + 1] = Math.round(G * alpha);
      buf[i + 2] = Math.round(R * alpha);
      buf[i + 3] = Math.round(255 * alpha);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
