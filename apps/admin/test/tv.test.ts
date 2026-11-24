import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  defaultTvConfig,
  type PcRecord,
  type PcRuntime,
  type SiteSettings,
  type TvDisplayConfig,
} from '@vade/protocol';
import { buildBackupEntries, validateAndImportBackupZip, writeBackupZip, type BackupStoreLike } from '../src/main/backup';
import { AdminStore } from '../src/main/store';
import { TvPublisher } from '../src/main/tvPublisher';
import { TvServer } from '../src/main/tvServer';
import { TvStore } from '../src/main/tvStore';
import { writeZipFile } from '../src/main/zip';
import { defaultMapLayout } from '../src/shared/mapLayout';

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_B64}`;
const SVG_1_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#2ef2c4"/></svg>', 'utf8').toString('base64');
const SVG_DATA_URL = `data:image/svg+xml;base64,${SVG_1_B64}`;
const SVG_2_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e040fb"/></svg>', 'utf8').toString('base64');
const SVG_2_DATA_URL = `data:image/svg+xml;base64,${SVG_2_B64}`;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-tv-test-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRuntime(pcId: number, state: 'free' | 'occupied' | 'maintenance' | 'offline'): PcRuntime | undefined {
  if (state === 'offline') return undefined;
  return {
    pcId,
    link: 'online',
    info: null,
    sleeping: false,
    lastSeen: new Date().toISOString(),
    lastError: null,
    wolSentAt: null,
    status: {
      state: state === 'maintenance' ? 'updating' : 'idle',
      job: null,
      lastJob: null,
      nextRunAt: null,
      pendingPower: null,
      configRev: 'rev1',
      steamcmdInstalled: true,
      dryRun: false,
      occupancy: state === 'free' ? 'free' : 'occupied',
    },
  };
}

function readSseEvent(
  res: http.IncomingMessage,
  predicate: (event: string, data: unknown) => boolean,
  timeoutMs = 3000,
): Promise<{ event: string; data: unknown }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for SSE event. Buffer so far:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          const parsed = JSON.parse(dataLines.join('\n')) as unknown;
          if (predicate(event, parsed)) {
            cleanup();
            resolve({ event, data: parsed });
            return;
          }
        }
        sep = buffer.indexOf('\n\n');
      }
    };

    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      res.off('data', onData);
      res.off('error', onErr);
    };

    res.on('data', onData);
    res.on('error', onErr);
  });
}

describe('TvStore', () => {
  it('extracts images to tv-assets, hydrates/serves URLs, cleans orphans, and reloads from disk', () => {
    const store = new TvStore(tmp);
    expect(fs.existsSync(store.configFile)).toBe(false);

    const saved = store.save({
      ...defaultTvConfig(),
      lang: 'ua',
      defaultSlideDurationSec: 12,
      slides: [
        {
          id: 'promo-1',
          enabled: true,
          imageDataUrl: PNG_DATA_URL,
          mode: 'with_text',
          title: 'Night Pass',
          subtitle: '22:00 - 06:00',
        },
      ],
      qrCards: [
        {
          id: 'qr-1',
          enabled: true,
          label: 'Instagram',
          qrSource: 'upload',
          qrImageDataUrl: SVG_DATA_URL,
          bgType: 'image',
          bgColor: '#161b26',
          bgImageDataUrl: SVG_2_DATA_URL,
        },
      ],
    });

    expect(saved.updatedAt).toBeGreaterThan(0);
    expect(saved.slides[0].imageDataUrl).toBe(PNG_DATA_URL);
    expect(saved.qrCards[0].qrImageDataUrl).toBe(SVG_DATA_URL);
    expect(saved.qrCards[0].bgImageDataUrl).toBe(SVG_2_DATA_URL);

    // On disk, tv-config.json stores @asset:<sha256_16>.<ext>
    const diskJson = JSON.parse(fs.readFileSync(store.configFile, 'utf8')) as TvDisplayConfig;
    expect(diskJson.slides[0].imageDataUrl).toMatch(/^@asset:[a-f0-9]{16}\.png$/);
    expect(diskJson.qrCards[0].qrImageDataUrl).toMatch(/^@asset:[a-f0-9]{16}\.svg$/);
    expect(diskJson.qrCards[0].bgImageDataUrl).toMatch(/^@asset:[a-f0-9]{16}\.svg$/);

    const assetsBefore = fs.readdirSync(store.assetsDir);
    expect(assetsBefore).toHaveLength(3);

    const localServed = store.getLocalServedConfig();
    expect(localServed.slides[0].imageDataUrl).toMatch(/^\/tv-assets\/[a-f0-9]{16}\.png$/);
    const slideAssetName = localServed.slides[0].imageDataUrl.slice('/tv-assets/'.length);
    const resolved = store.resolveAsset(slideAssetName);
    expect(resolved).not.toBeNull();
    expect(resolved?.contentType).toBe('image/png');

    // Security: reject traversal and invalid names
    expect(store.resolveAsset('../tv-config.json')).toBeNull();
    expect(store.resolveAsset('..\\tv-config.json')).toBeNull();
    expect(store.resolveAsset('not-a-hash.png')).toBeNull();
    expect(store.resolveAsset('0123456789abcdef.exe')).toBeNull();
    expect(store.resolveAsset('0123456789abcdef.png')).toBeNull();

    // Reload from disk in a fresh instance preserves everything
    const store2 = new TvStore(tmp);
    const hydrated2 = store2.getHydratedConfig();
    expect(hydrated2.lang).toBe('ua');
    expect(hydrated2.slides[0].imageDataUrl).toBe(PNG_DATA_URL);
    expect(hydrated2.qrCards[0].qrImageDataUrl).toBe(SVG_DATA_URL);

    // Save keeping localServed slide URL and dropping QR images -> prunes orphaned QR assets
    store2.save({
      ...localServed,
      qrCards: [
        {
          id: 'qr-gen',
          enabled: true,
          label: 'WiFi',
          qrSource: 'generate',
          qrText: 'WIFI:T:WPA;S:VADE;P:1234;;',
          bgType: 'color',
          bgColor: '#161b26',
        },
      ],
    });

    const assetsAfter = fs.readdirSync(store2.assetsDir);
    expect(assetsAfter).toEqual([slideAssetName]);

    // Corrupt primary config falls back to .bak cleanly on reloadFromDisk()
    fs.writeFileSync(store2.configFile, '{bad-json');
    const recovered = store2.reloadFromDisk();
    expect(recovered.slides[0].imageDataUrl).toBe(PNG_DATA_URL);
  });
});

describe('TvServer', () => {
  it('serves kiosk HTML, API routes, QR SVG, assets, SSE updates, and handles port conflicts', async () => {
    const store = new TvStore(tmp);
    store.save({
      ...defaultTvConfig(),
      lang: 'pl',
      localServerEnabled: true,
      slides: [{ id: 's1', enabled: true, imageDataUrl: PNG_DATA_URL, mode: 'image_only' }],
      qrCards: [
        {
          id: 'q1',
          enabled: true,
          label: 'Book',
          qrSource: 'generate',
          qrText: 'https://vade.club',
          bgType: 'color',
          bgColor: '#161b26',
        },
      ],
    });

    const pcs: PcRecord[] = [
      { id: 1, ip: '10.70.4.11', mac: 'aa:bb:cc:dd:ee:01', zone: 'Regular', name: 'PC-01' },
      { id: 2, ip: '10.70.4.12', mac: 'aa:bb:cc:dd:ee:02', zone: 'Regular', name: 'PC-02' },
      { id: 3, ip: '10.70.4.13', mac: 'aa:bb:cc:dd:ee:03', zone: 'Stream', name: 'PC-03', serviceNote: { outOfService: true, text: 'GPU', updatedAt: 1 } },
      { id: 4, ip: '10.70.4.14', mac: 'aa:bb:cc:dd:ee:04', zone: 'Stream', name: 'PC-04' },
    ];
    const runtimes = new Map<number, PcRuntime | undefined>([
      [1, makeRuntime(1, 'free')],
      [2, makeRuntime(2, 'occupied')],
      [3, makeRuntime(3, 'free')],
      [4, undefined],
    ]);
    let layout = defaultMapLayout();

    const server = new TvServer({
      getConfig: () => store.getHydratedConfig(),
      getServedConfig: () => store.getLocalServedConfig(),
      resolveAsset: (name) => store.resolveAsset(name),
      getPcs: () => pcs,
      getRuntime: (id) => runtimes.get(id),
      getMapLayout: () => layout,
      getLocalIps: () => ['127.0.0.1'],
      portOverride: 0,
    });

    await server.start();
    const st = server.status();
    expect(st.running).toBe(true);
    expect(st.port).toBeGreaterThan(0);
    expect(st.urls).toEqual([`http://127.0.0.1:${st.port}`]);
    const baseUrl = `http://127.0.0.1:${st.port}`;

    try {
      // Kiosk HTML routes
      for (const route of ['/', '/tv', '/tv.html']) {
        const res = await fetch(`${baseUrl}${route}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const html = await res.text();
        expect(html).toContain("EventSource('/api/events')");
      }

      // /api/status
      const statusRes = await fetch(`${baseUrl}/api/status`);
      expect(statusRes.status).toBe(200);
      const statusJson = (await statusRes.json()) as {
        free: number;
        busy: number;
        maintenance: number;
        offline: number;
        total: number;
        pcs: Array<{ id: number; state: string; pos: { x: number; y: number } | null }>;
      };
      expect(statusJson).toMatchObject({ free: 1, busy: 1, maintenance: 1, offline: 1, total: 4 });
      expect(statusJson.pcs.find((p) => p.id === 1)?.state).toBe('free');
      expect(statusJson.pcs.find((p) => p.id === 2)?.state).toBe('busy');
      expect(statusJson.pcs.find((p) => p.id === 3)?.state).toBe('maintenance');
      expect(statusJson.pcs.find((p) => p.id === 4)?.state).toBe('offline');
      expect(statusJson.pcs.find((p) => p.id === 1)?.pos).toEqual({ x: 10, y: 1 });

      // /api/tv-config and ?inline=1
      const cfgLocal = (await (await fetch(`${baseUrl}/api/tv-config`)).json()) as TvDisplayConfig;
      expect(cfgLocal.slides[0].imageDataUrl).toMatch(/^\/tv-assets\/[a-f0-9]{16}\.png$/);
      const cfgInline = (await (await fetch(`${baseUrl}/api/tv-config?inline=1`)).json()) as TvDisplayConfig;
      expect(cfgInline.slides[0].imageDataUrl).toBe(PNG_DATA_URL);

      // /api/map-layout
      const mapRes = (await (await fetch(`${baseUrl}/api/map-layout`)).json()) as { cols: number; rows: number };
      expect(mapRes.cols).toBe(layout.cols);
      expect(mapRes.rows).toBe(layout.rows);

      // /api/qr
      const qrRes = await fetch(`${baseUrl}/api/qr?text=${encodeURIComponent('https://vade.club')}`);
      expect(qrRes.status).toBe(200);
      expect(qrRes.headers.get('content-type')).toContain('image/svg+xml');
      const qrSvg = await qrRes.text();
      expect(qrSvg).toContain('<svg');
      expect((await fetch(`${baseUrl}/api/qr`)).status).toBe(400);

      // /tv-assets/:name and traversal rejection
      const assetRes = await fetch(`${baseUrl}${cfgLocal.slides[0].imageDataUrl}`);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get('content-type')).toBe('image/png');
      expect(assetRes.headers.get('cache-control')).toContain('immutable');
      const assetBuf = Buffer.from(await assetRes.arrayBuffer());
      expect(assetBuf.toString('base64')).toBe(PNG_1X1_B64);

      expect((await fetch(`${baseUrl}/tv-assets/..%2Ftv-config.json`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/tv-assets/missing012345678.png`)).status).toBe(404);

      // SSE /api/events receives initial status, config, layout and live updates
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/events`, async (res) => {
          try {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');

            const initStatus = await readSseEvent(res, (e) => e === 'status');
            expect((initStatus.data as { free: number }).free).toBe(1);
            expect(server.status().clients).toBe(1);

            // Trigger status change
            runtimes.set(4, makeRuntime(4, 'free'));
            server.notifyStatus();
            const updatedStatus = await readSseEvent(res, (e) => e === 'status');
            expect((updatedStatus.data as { free: number }).free).toBe(2);

            // Trigger config change via reconfigure
            store.save({ ...store.getHydratedConfig(), lang: 'en' });
            await server.reconfigure();
            const updatedCfg = await readSseEvent(res, (e) => e === 'config');
            expect((updatedCfg.data as TvDisplayConfig).lang).toBe('en');

            // Trigger layout change
            layout = { ...layout, labels: [] };
            server.notifyLayout();
            const updatedLayout = await readSseEvent(res, (e) => e === 'layout');
            expect((updatedLayout.data as { labels: unknown[] }).labels).toHaveLength(0);

            req.destroy();
            resolve();
          } catch (err) {
            req.destroy();
            reject(err);
          }
        });
        req.on('error', reject);
      });

      // Wait briefly for socket close cleanup
      await new Promise((r) => setTimeout(r, 30));
      expect(server.status().clients).toBe(0);

      // EADDRINUSE handling on second server bound to same port
      const conflictingServer = new TvServer({
        getConfig: () => ({ ...store.getHydratedConfig(), localServerPort: st.port }),
        getServedConfig: () => store.getLocalServedConfig(),
        resolveAsset: (name) => store.resolveAsset(name),
        getPcs: () => pcs,
        getRuntime: (id) => runtimes.get(id),
        getMapLayout: () => layout,
        getLocalIps: () => ['127.0.0.1'],
      });
      await conflictingServer.start();
      expect(conflictingServer.status().running).toBe(false);
      expect(conflictingServer.status().error).toBeTruthy();

      // Reconfigure disables server cleanly
      store.save({ ...store.getHydratedConfig(), localServerEnabled: false });
      await server.reconfigure();
      expect(server.status().running).toBe(false);
      expect(server.status().enabled).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

describe('TvPublisher', () => {
  it('posts hydrated TvDisplayConfig with Bearer token to derived /api/tv-config URL and tracks status', async () => {
    const store = new TvStore(tmp);
    store.save({
      ...defaultTvConfig(),
      lang: 'ua',
      slides: [{ id: 's1', enabled: true, imageDataUrl: PNG_DATA_URL, mode: 'image_only' }],
    });

    const site: SiteSettings = {
      enabled: true,
      url: 'https://club.vade.gg/api/club-status',
      token: '  super-secret-token  ',
      heartbeatSec: 600,
      debounceSec: 2,
      dailyLimit: 900,
    };

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: 'OK' });
    };

    const publisher = new TvPublisher({
      getSiteSettings: () => site,
      getHydratedConfig: () => store.getHydratedConfig(),
      userAgent: 'VadeAdmin/0.6.0',
      fetchImpl: fetchMock,
    });

    const emitted: ReturnType<TvPublisher['status']>[] = [];
    publisher.on('status', (s) => emitted.push(s));

    const res = await publisher.publish();
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://club.vade.gg/api/tv-config');
    expect(res.status).toBe(200);
    expect(res.bytes).toBeGreaterThan(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://club.vade.gg/api/tv-config');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer super-secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    const postedBody = JSON.parse(String(calls[0].init.body)) as TvDisplayConfig;
    expect(postedBody.slides[0].imageDataUrl).toBe(PNG_DATA_URL);

    expect(publisher.status().lastPublishAt).toBeTruthy();
    expect(publisher.status().lastResult?.ok).toBe(true);
    expect(emitted).toHaveLength(1);

    // HTTP failure and missing URL handling
    const errPublisher = new TvPublisher({
      getSiteSettings: () => ({ ...site, url: 'https://club.vade.gg/api/club-status' }),
      getHydratedConfig: () => store.getHydratedConfig(),
      userAgent: 'VadeAdmin/0.6.0',
      fetchImpl: async () => new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    });
    const badRes = await errPublisher.publish();
    expect(badRes.ok).toBe(false);
    expect(badRes.status).toBe(401);
    expect(badRes.error).toContain('401');

    const emptyUrlPublisher = new TvPublisher({
      getSiteSettings: () => ({ ...site, url: '' }),
      getHydratedConfig: () => store.getHydratedConfig(),
      userAgent: 'VadeAdmin/0.6.0',
    });
    const noUrlRes = await emptyUrlPublisher.publish();
    expect(noUrlRes.ok).toBe(false);
    expect(noUrlRes.error).toBeTruthy();
  });
});

describe('Backup integration for TV config & assets', () => {
  function makeBackupStore(dir: string, clubKey: string): BackupStoreLike & { tvStore: TvStore; tvReloads: number } {
    const admin = new AdminStore(dir);
    admin.settings = { ...admin.settings, security: { ...admin.settings.security, clubKey } };
    fs.writeFileSync(admin.settingsFile, JSON.stringify(admin.settings, null, 2));
    const tvStore = new TvStore(dir);
    const wrapper: BackupStoreLike & { tvStore: TvStore; tvReloads: number } = {
      dir: admin.dir,
      settings: admin.settings,
      pcs: admin.pcs,
      mapLayout: admin.mapLayout,
      settingsFile: admin.settingsFile,
      pcsFile: admin.pcsFile,
      mapFile: admin.mapFile,
      tvStore,
      tvReloads: 0,
      reloadFromDisk() {
        admin.reloadFromDisk();
        this.settings = admin.settings;
        this.pcs = admin.pcs;
        this.mapLayout = admin.mapLayout;
      },
      tvReloadFromDisk() {
        this.tvReloads++;
        tvStore.reloadFromDisk();
      },
    };
    return wrapper;
  }

  it('roundtrips tv-config.json and tv-assets/* in backup ZIP and rejects unsafe tv-assets entries', async () => {
    const src = makeBackupStore(path.join(tmp, 'src'), 'source-club-key-0123456789abcdef');
    src.tvStore.save({
      ...defaultTvConfig(),
      lang: 'en',
      slides: [{ id: 's1', enabled: true, imageDataUrl: PNG_DATA_URL, mode: 'with_text', title: 'Promo' }],
      qrCards: [
        {
          id: 'q1',
          enabled: true,
          label: 'Discord',
          qrSource: 'upload',
          qrImageDataUrl: SVG_DATA_URL,
          bgType: 'color',
          bgColor: '#161b26',
        },
      ],
    });

    const entries = buildBackupEntries(src, '0.6.0');
    const names = entries.map((e) => e.name);
    expect(names).toContain('tv-config.json');
    expect(names.some((n) => /^tv-assets\/[a-f0-9]{16}\.png$/.test(n))).toBe(true);
    expect(names.some((n) => /^tv-assets\/[a-f0-9]{16}\.svg$/.test(n))).toBe(true);

    const zipPath = path.join(tmp, 'tv-backup.zip');
    await writeBackupZip(zipPath, src, '0.6.0');

    const dst = makeBackupStore(path.join(tmp, 'dst'), 'target-club-key-0123456789abcdef');
    dst.tvStore.save({
      ...defaultTvConfig(),
      lang: 'pl',
      slides: [{ id: 'old', enabled: true, imageDataUrl: SVG_2_DATA_URL, mode: 'image_only' }],
    });

    const res = await validateAndImportBackupZip(zipPath, dst);
    expect(res.manifest.format).toBe('vade-backup');
    expect(dst.tvReloads).toBe(1);

    const restored = dst.tvStore.getHydratedConfig();
    expect(restored.lang).toBe('en');
    expect(restored.slides).toHaveLength(1);
    expect(restored.slides[0].imageDataUrl).toBe(PNG_DATA_URL);
    expect(restored.qrCards[0].qrImageDataUrl).toBe(SVG_DATA_URL);
    // Old SVG_2 asset should have been cleaned up and backed up in preBackupDir
    expect(fs.readdirSync(dst.tvStore.assetsDir)).toHaveLength(2);
    expect(fs.existsSync(path.join(res.preBackupDir, 'tv-config.json'))).toBe(true);

    // Reject backup ZIP with invalid tv-assets filename without modifying target
    const badZipPath = path.join(tmp, 'bad-tv-asset.zip');
    await writeZipFile(badZipPath, [
      { name: 'manifest.json', data: JSON.stringify({ format: 'vade-backup', version: 1, appVersion: '0.6.0', createdAt: new Date().toISOString(), files: [] }) },
      { name: 'settings.json', data: JSON.stringify(defaultSettings('valid-key-0123456789abcdef')) },
      { name: 'pcs.json', data: JSON.stringify(dst.pcs) },
      { name: 'map_layout.json', data: JSON.stringify(dst.mapLayout) },
      { name: 'tv-config.json', data: JSON.stringify(defaultTvConfig()) },
      { name: 'tv-assets/evil.txt', data: 'bad' },
    ]);

    await expect(validateAndImportBackupZip(badZipPath, dst)).rejects.toThrow(/TV/i);
    expect(dst.tvStore.getHydratedConfig().lang).toBe('en');
  });
});
