import { Download, Gamepad2, LoaderCircle, Plus, RefreshCw, Search, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, InstalledSteamGame, PcRecord, PcRuntime } from '@vade/protocol';
import type { PcGamesResult } from '../shared/api';
import { api, errorText } from './api';
import { fmtBytes, zonesOf } from './format';
import { useI18n } from './i18n';
import { ConfirmDialog, Modal, Segmented, useToast } from './ui';

interface Props {
  pcs: PcRecord[];
  runtimes: Record<number, PcRuntime>;
  settings: AppSettings;
  onSettingsSaved: (s: AppSettings) => void;
}

type MatrixFilter = 'all' | 'club' | 'alien' | 'missing';

interface GameRow {
  appId: number;
  name: string;
  isClub: boolean;
  installedOn: Map<number, InstalledSteamGame>;
  avgBytes: number;
  missingCount: number;
}

export function GamesView({ pcs, runtimes, settings, onSettingsSaved }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [zone, setZone] = useState('all');
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [byPc, setByPc] = useState<Record<number, PcGamesResult>>({});
  const [newClubId, setNewClubId] = useState('');
  const [confirmUninstall, setConfirmUninstall] = useState<{ pcId: number; game: InstalledSteamGame } | null>(null);
  const [bulkAlienRow, setBulkAlienRow] = useState<GameRow | null>(null);
  const [installModal, setInstallModal] = useState<{ appId: number; name: string; selectedPcs: Set<number> } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const zones = useMemo(() => zonesOf(pcs), [pcs]);
  const visiblePcs = useMemo(
    () => pcs.filter((p) => zone === 'all' || p.zone === zone),
    [pcs, zone],
  );
  const onlinePcs = useMemo(
    () => visiblePcs.filter((p) => runtimes[p.id]?.link === 'online'),
    [visiblePcs, runtimes],
  );

  const refresh = useCallback(async () => {
    const ids = pcs.filter((p) => runtimes[p.id]?.link === 'online').map((p) => p.id);
    if (ids.length === 0) {
      setByPc({});
      return;
    }
    setLoading(true);
    try {
      const list = await api.listGames(ids);
      setByPc(Object.fromEntries(list.map((r) => [r.pcId, r])));
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setLoading(false);
    }
  }, [pcs, runtimes, toast]);

  useEffect(() => {
    void refresh();
    // Load once when opening tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clubSet = useMemo(() => new Set(settings.clubAppIds), [settings.clubAppIds]);

  const rows = useMemo<GameRow[]>(() => {
    const map = new Map<number, { name: string; installedOn: Map<number, InstalledSteamGame> }>();
    for (const id of settings.clubAppIds) {
      map.set(id, { name: `App ${id}`, installedOn: new Map() });
    }
    for (const p of visiblePcs) {
      const r = byPc[p.id];
      if (!r?.ok) continue;
      for (const g of r.games) {
        let entry = map.get(g.appId);
        if (!entry) {
          entry = { name: g.name, installedOn: new Map() };
          map.set(g.appId, entry);
        } else if (entry.name.startsWith('App ') && g.name && !g.name.startsWith('App ')) {
          entry.name = g.name;
        }
        entry.installedOn.set(p.id, g);
      }
    }
    const polledOnlineCount = visiblePcs.filter((p) => byPc[p.id]?.ok).length;
    const out: GameRow[] = [];
    for (const [appId, data] of map) {
      const sizes = [...data.installedOn.values()].map((g) => g.sizeOnDiskBytes).filter((n) => n > 0);
      const avgBytes = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
      const isClub = clubSet.has(appId);
      const missingCount = isClub ? Math.max(0, polledOnlineCount - data.installedOn.size) : 0;
      out.push({ appId, name: data.name, isClub, installedOn: data.installedOn, avgBytes, missingCount });
    }
    return out.sort((a, b) => Number(a.isClub) - Number(b.isClub) || a.name.localeCompare(b.name));
  }, [settings.clubAppIds, visiblePcs, byPc, clubSet]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      club: rows.filter((r) => r.isClub).length,
      alien: rows.filter((r) => !r.isClub).length,
      missing: rows.filter((r) => r.isClub && r.missingCount > 0).length,
    }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'club' && !r.isClub) return false;
      if (filter === 'alien' && r.isClub) return false;
      if (filter === 'missing' && !(r.isClub && r.missingCount > 0)) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || String(r.appId).includes(q);
    });
  }, [rows, filter, query]);

  const polledCount = visiblePcs.filter((p) => byPc[p.id]?.ok).length;

  const toggleClubApp = async (appId: number) => {
    const next = structuredClone(settings);
    if (next.clubAppIds.includes(appId)) {
      next.clubAppIds = next.clubAppIds.filter((x) => x !== appId);
    } else {
      next.clubAppIds = [...next.clubAppIds, appId];
    }
    try {
      onSettingsSaved(await api.saveSettings(next));
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const addClubAppById = async () => {
    const id = Number(newClubId.trim());
    if (!Number.isInteger(id) || id <= 0) return;
    setNewClubId('');
    if (!settings.clubAppIds.includes(id)) {
      await toggleClubApp(id);
    }
  };

  const uninstallOne = async (pcId: number, g: InstalledSteamGame) => {
    setBusyKey(`un:${pcId}:${g.appId}`);
    try {
      const res = await api.uninstallGame(pcId, g.appId, g.libraryPath);
      toast(res.ok ? 'ok' : 'warn', `${t('common.pcNum', { id: pcId })}: ${res.message}`);
      await refresh();
    } catch (e) {
      toast('error', errorText(e));
    } finally {
      setBusyKey(null);
    }
  };

  const uninstallAlienEverywhere = async (row: GameRow) => {
    const targets = [...row.installedOn.entries()];
    setBulkAlienRow(null);
    setBusyKey(`bulk-un:${row.appId}`);
    let ok = 0;
    let err = 0;
    for (const [pcId, g] of targets) {
      try {
        const res = await api.uninstallGame(pcId, g.appId, g.libraryPath);
        if (res.ok) ok++;
        else err++;
      } catch {
        err++;
      }
    }
    setBusyKey(null);
    toast(err ? 'warn' : 'ok', t('games.bulkUninstallDone', { name: row.name, ok, err }));
    await refresh();
  };

  const startInstallOnSelected = async () => {
    if (!installModal) return;
    const { appId, name, selectedPcs } = installModal;
    const ids = [...selectedPcs];
    setInstallModal(null);
    setBusyKey(`in:${appId}`);
    let ok = 0;
    for (const pcId of ids) {
      try {
        const res = await api.installGame(pcId, appId);
        if (res.ok) ok++;
        else toast('error', `${t('common.pcNum', { id: pcId })} (${name}): ${res.message}`);
      } catch (e) {
        toast('error', `${t('common.pcNum', { id: pcId })} (${name}): ${errorText(e)}`);
      }
    }
    setBusyKey(null);
    if (ok > 0) toast('ok', t('games.installDone', { name, ok, total: ids.length }));
    await refresh();
  };

  const openInstallModal = (row: GameRow, singlePcId?: number) => {
    const targets =
      singlePcId != null
        ? new Set([singlePcId])
        : new Set(onlinePcs.filter((p) => !row.installedOn.has(p.id)).map((p) => p.id));
    setInstallModal({ appId: row.appId, name: row.name, selectedPcs: targets });
  };

  return (
    <div className="page" style={{ maxWidth: 1420 }}>
      <div className="page-title">
        <h1>
          <Gamepad2 size={20} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {t('games.title')}
        </h1>
        <span className="dim">{t('games.subtitle')}</span>
      </div>

      <section className="section">
        <div className="toolbar-row" style={{ marginBottom: 12 }}>
          <Segmented
            value={zone}
            onChange={setZone}
            options={[
              { value: 'all', label: `${t('pcs.all')} (${pcs.length})` },
              ...zones.map((z) => ({ value: z, label: `${z} (${pcs.filter((p) => p.zone === z).length})` })),
            ]}
          />
          <Segmented<MatrixFilter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('games.filterAll', { count: counts.all }) },
              { value: 'club', label: t('games.filterClub', { count: counts.club }) },
              { value: 'alien', label: t('games.filterAlien', { count: counts.alien }) },
              { value: 'missing', label: t('games.filterMissing', { count: counts.missing }) },
            ]}
          />
          <div className="search">
            <Search size={14} />
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('games.search')} />
          </div>
          <span className="spacer" />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input mono"
              style={{ width: 175 }}
              value={newClubId}
              placeholder={t('games.addClubPlaceholder')}
              onChange={(e) => setNewClubId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addClubAppById()}
            />
            <button className="btn small" onClick={() => void addClubAppById()}>
              <Plus size={14} /> {t('games.addClubBtn')}
            </button>
          </div>
          <button className="btn primary small" disabled={loading || onlinePcs.length === 0} onClick={() => void refresh()}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {t('common.refresh')}
          </button>
        </div>

        {onlinePcs.length === 0 ? (
          <div className="empty" style={{ padding: '24px 12px' }}>
            {t('games.noOnlinePcs')}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty" style={{ padding: '24px 12px' }}>
            {t('games.empty')}
          </div>
        ) : (
          <div className="matrix-wrap">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th className="matrix-sticky">{t('games.colGame')}</th>
                  <th>{t('games.colCoverage')}</th>
                  <th>{t('games.colSize')}</th>
                  <th>{t('games.colActions')}</th>
                  {visiblePcs.map((p) => {
                    const isOnline = runtimes[p.id]?.link === 'online';
                    return (
                      <th key={p.id} className={`matrix-pc-head ${isOnline ? '' : 'dim'}`} title={`${p.zone} · ${p.ip}`}>
                        №{p.id}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const rowBusy = busyKey?.endsWith(`:${row.appId}`);
                  return (
                    <tr key={row.appId} className={row.isClub ? '' : 'matrix-row-alien'}>
                      <td className="matrix-sticky">
                        <div className="matrix-game-cell">
                          <button
                            type="button"
                            className={`icon-btn matrix-star ${row.isClub ? 'on' : ''}`}
                            title={row.isClub ? t('games.unmarkClub') : t('games.markClub')}
                            onClick={() => void toggleClubApp(row.appId)}
                          >
                            <Star size={13} fill={row.isClub ? 'currentColor' : 'none'} />
                          </button>
                          <div style={{ minWidth: 0 }}>
                            <div className="matrix-game-name">{row.name}</div>
                            <div className="matrix-game-meta mono">
                              AppID {row.appId} ·{' '}
                              <span className={row.isClub ? 's-ok' : 's-warn'}>{row.isClub ? t('games.badgeClub') : t('games.badgeAlien')}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">
                        {row.installedOn.size}/{polledCount}
                      </td>
                      <td className="mono dim">{row.avgBytes > 0 ? fmtBytes(row.avgBytes) : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {!row.isClub && row.installedOn.size > 0 && (
                            <button
                              className="btn small danger"
                              disabled={!!busyKey}
                              title={t('games.uninstallBtn')}
                              onClick={() => setBulkAlienRow(row)}
                            >
                              {rowBusy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
                            </button>
                          )}
                          {row.isClub && row.missingCount > 0 && (
                            <button
                              className="btn small"
                              disabled={!!busyKey}
                              title={t('games.installMissingBtn')}
                              onClick={() => openInstallModal(row)}
                            >
                              {rowBusy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
                            </button>
                          )}
                        </div>
                      </td>
                      {visiblePcs.map((p) => {
                        const r = byPc[p.id];
                        const isOnline = runtimes[p.id]?.link === 'online';
                        if (!isOnline || !r?.ok) {
                          return (
                            <td key={p.id} className="matrix-cell dim">
                              ·
                            </td>
                          );
                        }
                        const inst = row.installedOn.get(p.id);
                        if (inst) {
                          if (!row.isClub) {
                            return (
                              <td
                                key={p.id}
                                className="matrix-cell alien"
                                title={`${inst.name} (${fmtBytes(inst.sizeOnDiskBytes)}) — ${inst.libraryPath}`}
                                onClick={() => setConfirmUninstall({ pcId: p.id, game: inst })}
                              >
                                {inst.sizeOnDiskBytes > 0 ? fmtBytes(inst.sizeOnDiskBytes) : '✓'}
                              </td>
                            );
                          }
                          return (
                            <td key={p.id} className="matrix-cell ok" title={inst.libraryPath}>
                              ✓
                            </td>
                          );
                        }
                        if (row.isClub) {
                          return (
                            <td
                              key={p.id}
                              className="matrix-cell missing"
                              title={t('games.installMissingBtn')}
                              onClick={() => openInstallModal(row, p.id)}
                            >
                              —
                            </td>
                          );
                        }
                        return <td key={p.id} className="matrix-cell" />;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirmUninstall && (
        <ConfirmDialog
          title={t('games.uninstallOne', { pcId: confirmUninstall.pcId })}
          text={t('games.uninstallConfirm', {
            name: confirmUninstall.game.name,
            appId: confirmUninstall.game.appId,
            lib: confirmUninstall.game.libraryPath,
            pcId: confirmUninstall.pcId,
          })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => void uninstallOne(confirmUninstall.pcId, confirmUninstall.game)}
          onClose={() => setConfirmUninstall(null)}
        />
      )}

      {bulkAlienRow && (
        <ConfirmDialog
          title={`${t('games.uninstallBtn')}: ${bulkAlienRow.name}`}
          text={t('games.bulkUninstallConfirm', { name: bulkAlienRow.name, appId: bulkAlienRow.appId, count: bulkAlienRow.installedOn.size })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => void uninstallAlienEverywhere(bulkAlienRow)}
          onClose={() => setBulkAlienRow(null)}
        />
      )}

      {installModal && (
        <Modal
          title={t('games.installModalTitle', { name: installModal.name, appId: installModal.appId })}
          icon={<Download size={18} color="var(--accent)" />}
          onClose={() => setInstallModal(null)}
          footer={
            <>
              <button className="btn" onClick={() => setInstallModal(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn primary"
                disabled={installModal.selectedPcs.size === 0}
                onClick={() => void startInstallOnSelected()}
              >
                {t('games.installStart', { count: installModal.selectedPcs.size })}
              </button>
            </>
          }
        >
          <div className="radio-row" style={{ flexDirection: 'column', gap: 6, maxHeight: 320, overflow: 'auto' }}>
            {onlinePcs.map((p) => {
              const checked = installModal.selectedPcs.has(p.id);
              const already = !!byPc[p.id]?.games.some((g) => g.appId === installModal.appId);
              return (
                <label key={p.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(installModal.selectedPcs);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setInstallModal({ ...installModal, selectedPcs: next });
                    }}
                  />{' '}
                  <strong>{t('common.pcNum', { id: p.id })}</strong> ({p.zone}){' '}
                  {already ? <span className="dim">{t('games.alreadyInstalled')}</span> : <span className="s-warn">{t('games.missingLabel')}</span>}
                </label>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
