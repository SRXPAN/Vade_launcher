import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TV_PORT,
  defaultTvConfig,
  deriveTvConfigUrl,
  encodeQrMatrix,
  isSafeTvImageRef,
  qrToSvg,
  qrToSvgDataUrl,
  sanitizeTvConfig,
  TV_LIMITS,
} from '../src';

describe('TV Display config contracts', () => {
  it('provides expected defaults matching TV_LIMITS', () => {
    const cfg = defaultTvConfig();
    expect(cfg).toEqual({
      updatedAt: 0,
      lang: 'pl',
      defaultSlideDurationSec: 8,
      localServerEnabled: true,
      localServerPort: DEFAULT_TV_PORT,
      slides: [],
      qrCards: [],
    });
    expect(DEFAULT_TV_PORT).toBe(7425);
  });

  it('sanitizes slides, QR cards, limits, IDs, ports, and unsafe image URIs', () => {
    const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const raw = {
      updatedAt: 1700000123.9,
      lang: 'uk',
      defaultSlideDurationSec: 999,
      localServerEnabled: false,
      localServerPort: 80,
      slides: Array.from({ length: 12 }, (_, i) => ({
        id: i < 2 ? 'dup' : `s-${i}`,
        enabled: i !== 1,
        imageDataUrl: i === 0 ? validPng : i === 2 ? 'javascript:alert(1)' : '/tv-assets/0123456789abcdef.webp',
        mode: i === 0 ? 'with_text' : 'invalid',
        title: `  Banner ${i}  `,
        subtitle: '  Promo  ',
        durationSec: 2,
      })),
      qrCards: Array.from({ length: 7 }, (_, i) => ({
        id: 'card',
        enabled: true,
        label: `Card ${i}`,
        sublabel: 'Scan me',
        qrSource: i === 0 ? 'generate' : 'upload',
        qrText: 'https://vade.pl',
        qrImageDataUrl: i === 1 ? validPng : 'data:text/html;base64,PGI+',
        bgType: i === 2 ? 'image' : 'color',
        bgColor: i === 0 ? '#12AB34' : 'not-a-color',
        bgImageDataUrl: '/tv-assets/fedcba9876543210.jpg',
      })),
    };

    const clean = sanitizeTvConfig(raw);
    expect(clean.updatedAt).toBe(1700000123);
    expect(clean.lang).toBe('ua');
    expect(clean.defaultSlideDurationSec).toBe(TV_LIMITS.maxDurationSec);
    expect(clean.localServerEnabled).toBe(false);
    expect(clean.localServerPort).toBe(TV_LIMITS.minPort);

    expect(clean.slides).toHaveLength(TV_LIMITS.maxSlides);
    expect(new Set(clean.slides.map((s) => s.id)).size).toBe(TV_LIMITS.maxSlides);
    expect(clean.slides[0].imageDataUrl).toBe(validPng);
    expect(clean.slides[0].mode).toBe('with_text');
    expect(clean.slides[0].title).toBe('Banner 0');
    expect(clean.slides[0].durationSec).toBe(TV_LIMITS.minDurationSec);
    expect(clean.slides[1].enabled).toBe(false);
    expect(clean.slides[2].imageDataUrl).toBe('');
    expect(clean.slides[3].imageDataUrl).toBe('/tv-assets/0123456789abcdef.webp');

    expect(clean.qrCards).toHaveLength(TV_LIMITS.maxQrCards);
    expect(new Set(clean.qrCards.map((c) => c.id)).size).toBe(TV_LIMITS.maxQrCards);
    expect(clean.qrCards[0].bgColor).toBe('#12ab34');
    expect(clean.qrCards[1].bgColor).toBe('#161b26');
    expect(clean.qrCards[1].qrImageDataUrl).toBe(validPng);
    expect(clean.qrCards[2].qrImageDataUrl).toBeUndefined();
    expect(clean.qrCards[2].bgImageDataUrl).toBe('/tv-assets/fedcba9876543210.jpg');
  });

  it('validates safe TV image refs strictly', () => {
    expect(isSafeTvImageRef('/tv-assets/abcdef0123456789.webp')).toBe(true);
    expect(isSafeTvImageRef('/tv-assets/../secret.png')).toBe(false);
    expect(isSafeTvImageRef('data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=')).toBe(true);
    expect(isSafeTvImageRef('https://evil.example/a.png')).toBe(false);
    expect(isSafeTvImageRef('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('derives /api/tv-config URL from configured club-status webhook URL', () => {
    expect(deriveTvConfigUrl('https://vade-cyberclub.pages.dev/api/club-status')).toBe('https://vade-cyberclub.pages.dev/api/tv-config');
    expect(deriveTvConfigUrl('http://localhost:8788/api/status?x=1')).toBe('http://localhost:8788/api/tv-config');
    expect(deriveTvConfigUrl('https://vade.pl')).toBe('https://vade.pl/api/tv-config');
    expect(deriveTvConfigUrl('')).toBeNull();
    expect(deriveTvConfigUrl('ftp://vade.pl/api/club-status')).toBeNull();
  });
});

describe('Pure-TS ISO/IEC 18004 QR encoder', () => {
  const hasFinderAt = (size: number, modules: boolean[], r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        if (modules[(r0 + r) * size + (c0 + c)] !== expected) return false;
      }
    }
    return true;
  };

  it('encodes short URLs into v1/v2 matrices with valid finder patterns', () => {
    const m = encodeQrMatrix('https://vade.pl');
    expect(m.size).toBe(25); // 15 bytes -> v2 (25x25) at ECC M
    expect(m.modules).toHaveLength(m.size * m.size);
    expect(hasFinderAt(m.size, m.modules, 0, 0)).toBe(true);
    expect(hasFinderAt(m.size, m.modules, 0, m.size - 7)).toBe(true);
    expect(hasFinderAt(m.size, m.modules, m.size - 7, 0)).toBe(true);
  });

  it('encodes UTF-8 and Wi-Fi credentials across larger versions and produces valid SVG data URLs', () => {
    const wifi = 'WIFI:T:WPA;S:VADE_5G_Київ;P:Super\\;Pass123;;';
    const m = encodeQrMatrix(wifi);
    expect(m.size).toBeGreaterThanOrEqual(29);
    const svg = qrToSvg(wifi);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0');
    const url = qrToSvgDataUrl(wifi);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(isSafeTvImageRef(url)).toBe(true);
  });
});
