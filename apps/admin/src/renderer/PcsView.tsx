import {
  ChevronDown,
  CircleStop,
  Ellipsis,
  KeyRound,
  Layers,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Map as MapIcon,
  Moon,
  PackageOpen,
  Play,
  Plus,
  Power,
  PowerOff,
  Radar,
  RotateCcw,
  Search,
  Snowflake,
  Terminal,
  User,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { deriveDisplayStatus, ERR_OCCUPIED, type AppSettings, type PcRecord, type PcRuntime } from '@vade/protocol';
import type { AgentUpdateStatus, PcAction, QueueRunStatus } from '../shared/api';
import { api, errorText } from './api';
import { DeployDialog } from './DeployDialog';
import { DiagDialog } from './DiagDialog';
import { ACTIONS, nextFreeId, occupancyOf, occupancyText, QUEUE_STATE_LABEL, scheduleLabel, zonesOf } from './format';
import { useI18n, type I18nKey } from './i18n';
import { LogDrawer } from './LogDrawer';
import { ClubMap, type SelectMode } from './map/ClubMap';
import { PcCard } from './PcCard';
import { PcEditor } from './PcEditor';
import { PinPromptModal } from './PinPromptModal';
import { AgentUpdateDialog, QueueDialog, RunBar } from './RunDialogs';
import { ScanDialog } from './ScanDialog';
import { SteamLoginDialog } from './SteamLoginDialog';
import { CheckBox, ConfirmDialog, Menu, Modal, Segmented, useToast } from './ui';

interface Props {
  pcs: PcRecord[];
  setPcs: (pcs: PcRecord[]) => void;
  runtimes: Record<number, PcRuntime>;
  settings: AppSettings;
  onSettingsSaved: (s: AppSettings) => void;
}

/** Actions that close Steam / games / browsers: they need the "player on the PC" warning. */
const KICKS_PLAYER: PcAction[] = ['test', 'run', 'clean-logins'];
const POWER_DANGER: PcAction[] = ['sleep', 'hibernate', 'shutdown', 'restart'];

const ACTION_KEY: Record<PcAction, I18nKey> = {
  wake: 'action.wake',
  test: 'action.test',
  run: 'action.run',
  cancel: 'action.cancel',
  sleep: 'action.sleep',
  hibernate: 'action.hibernate',
  shutdown: 'action.shutdown',
  restart: 'action.restart',
  'cancel-power': 'action.cancelPower',
  'clean-logins': 'action.cleanLogins',
  'sync-time': 'action.syncTime',
};

type ViewMode = 'map' | 'cards';
const VIEW_KEY = 'vade.pcsView';

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'map';
  } catch {
    return 'map';
  }
}

export function PcsView({ pcs, setPcs, runtimes, settings, onSettingsSaved }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [view, setView] = useState<ViewMode>(loadViewMode);
  const [zone, setZone] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editor, setEditor] = useState<{ pc: PcRecord; originalId: number | null; onCreated?: (pc: PcRecord) => void } | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [steamFor, setSteamFor] = useState<number[] | null>(null);
  const [logPc, setLogPc] = useState<number | null>(null);
  const [diagPc, setDiagPc] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ action: PcAction; ids: number[] } | null>(null);
  const [occupiedPrompt, setOccupiedPrompt] = useState<{ action: PcAction; ids: number[]; busyIds: number[] } | null>(null);
  const [pinForAction, setPinForAction] = useState<{ action: PcAction; ids: number[]; force: boolean } | null>(null);
  const [busy, setBusy] = useState<PcAction | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueRunStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AgentUpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [latestAgent, setLatestAgent] = useState<string | null>(null);
  const [updateFor, setUpdateFor] = useState<number[] | null>(null);
  const [queueFor, setQueueFor] = useState<number[] | null>(null);
  const [deployFor, setDeployFor] = useState<number[] | null>(null);
  // Callbacks read runtimes through a ref so memoised cards are not re-rendered on every status tick.
  const rtRef = useRef(runtimes);
  rtRef.current = runtimes;

  useEffect(() => {
    void api.getQueueStatus().then(setQueueStatus);
    void api.getAgentUpdateStatus().then(setUpdateStatus);
    void api.getBundledAgent().then((s) => setLatestAgent(s?.version ?? null));
    const off1 = api.onQueueStatus(setQueueStatus);
    const off2 = api.onAgentUpdateStatus(setUpdateStatus);
    return () => {
      off1();
      off2();
    };
  }, []);

  /** Per-PC line "Черга: …" / "Оновлення агента: …" while something runs. */
  const runStates = useMemo(() => {
    const m: Record<number, string> = {};
    if (queueStatus?.active) {
      for (const i of queueStatus.items) if (i.state !== 'done') m[i.pcId] = `Черга: ${QUEUE_STATE_LABEL[i.state]}${i.message ? ` — ${i.message}` : ''}`;
    }
    if (updateStatus?.active) {
      for (const i of updateStatus.items) m[i.pcId] = `Оновлення агента: ${QUEUE_STATE_LABEL[i.state]}${i.message ? ` — ${i.message}` : ''}`;
    }
    return m;
  }, [queueStatus, updateStatus]);
  const openUpdate = useCallback((ids: number[]) => setUpdateFor(ids), []);

  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => pcs.some((p) => p.id === id))));
  }, [pcs]);

  const zones = useMemo(() => zonesOf(pcs), [pcs]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      pcs.filter((p) => {
        if (zone !== 'all' && p.zone !== zone) return false;
        if (!q) return true;
        const host = runtimes[p.id]?.info?.hostname ?? '';
        return [String(p.id), p.ip, p.mac, p.name ?? '', host].some((v) => v.toLowerCase().includes(q));
      }),
    [pcs, zone, q, runtimes],
  );
  const groups = zone === 'all' ? zones.map((z) => ({ zone: z, pcs: visible.filter((p) => p.zone === z) })).filter((g) => g.pcs.length) : [{ zone, pcs: visible }];
  const visibleIds = useMemo(() => new Set(visible.map((p) => p.id)), [visible]);
  const selIds = pcs.filter((p) => selected.has(p.id)).map((p) => p.id);
  const allVisible = visible.length > 0 && visible.every((p) => selected.has(p.id));
  const someVisible = visible.some((p) => selected.has(p.id));

  const changeView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // the choice is only a convenience
    }
  };

  const toggle = useCallback((id: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const selectOnMap = useCallback((ids: number[], mode: SelectMode) => {
    setSelected((s) => {
      if (mode === 'replace') return new Set(ids);
      const n = new Set(s);
      for (const id of ids) {
        if (mode === 'toggle' && n.has(id)) n.delete(id);
        else n.add(id);
      }
      return n;
    });
  }, []);
  const addPcAt = useCallback((id: number, zoneName: string, onCreated?: (pc: PcRecord) => void) => {
    setEditor({ pc: { id, ip: '', mac: '', zone: zoneName }, originalId: null, onCreated });
  }, []);
  const selectWhere = (pred: (p: PcRecord) => boolean) => setSelected(new Set(pcs.filter(pred).map((p) => p.id)));

  const execute = useCallback(
    async (action: PcAction, ids: number[], force = false) => {
      if (!ids.length) return;
      setBusy(action);
      try {
        const res = await api.runAction(action, ids, { force });
        const ok = res.filter((r) => r.ok);
        const bad = res.filter((r) => !r.ok);
        const who = ids.length === 1 ? `ПК №${ids[0]}` : `${ok.length} з ${ids.length} ПК`;
        if (!bad.length) toast('ok', `${ACTIONS[action].label}${force ? ' (примусово)' : ''}: ${who}${ids.length === 1 ? ` — ${ok[0].message}` : ''}`);
        else
          toast(
            ok.length ? 'warn' : 'error',
            `${ACTIONS[action].label}: успішно ${ok.length}, помилок ${bad.length}\n${bad
              .slice(0, 6)
              .map((r) => `ПК №${r.pcId}: ${r.message}`)
              .join('\n')}${bad.some((r) => r.code === ERR_OCCUPIED) ? '\nЗа цими ПК гравці — повторіть і оберіть «Примусово».' : ''}`,
          );
      } catch (e) {
        toast('error', errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const request = useCallback(
    (action: PcAction, ids: number[]) => {
      if (!ids.length) return;
      if (KICKS_PLAYER.includes(action)) {
        const busyIds = ids.filter((id) => occupancyOf(rtRef.current[id]) === 'occupied');
        if (busyIds.length) {
          setOccupiedPrompt({ action, ids, busyIds });
          return;
        }
      }
      if (ACTIONS[action].confirm) setConfirm({ action, ids });
      else void execute(action, ids);
    },
    [execute],
  );
  const occupiedAmong = (ids: number[]) => ids.filter((id) => occupancyOf(runtimes[id]) === 'occupied');

  const openEditor = useCallback((pc: PcRecord) => setEditor({ pc, originalId: pc.id }), []);
  const logPcRecord = logPc != null ? pcs.find((p) => p.id === logPc) : undefined;
  const diagPcRecord = diagPc != null ? pcs.find((p) => p.id === diagPc) : undefined;
  const hasPin = !!(settings.security.pinHash ?? '').trim();

  const runWithOptionalPin = (action: PcAction, ids: number[], force: boolean) => {
    const needsPin =
      hasPin &&
      ((POWER_DANGER.includes(action) && occupiedAmong(ids).length > 0 && (ids.length > 1 || action === 'shutdown' || action === 'restart')) ||
        (force && occupiedAmong(ids).length > 0 && KICKS_PLAYER.includes(action)));
    if (needsPin) {
      setPinForAction({ action, ids, force });
      return;
    }
    void execute(action, ids, force);
  };

  const bulk = (action: PcAction, icon: ReactNode) => (
    <button className={`btn small ${ACTIONS[action].danger ? 'danger' : ''}`} disabled={!selIds.length || busy != null} onClick={() => request(action, selIds)}>
      {busy === action ? <LoaderCircle size={14} className="spin" /> : icon}
      {t(ACTION_KEY[action])}
    </button>
  );

  return (
    <div className={`pcs-view ${view}${logPcRecord ? ' has-drawer' : ''}`}>
      <div className="pcs-main">
      <div className="toolbar">
        <div className="toolbar-row">
          <Segmented
            value={view}
            onChange={changeView}
            options={[
              {
                value: 'map',
                label: (
                  <span className="seg-icon">
                    <MapIcon size={14} /> {t('pcs.viewMap')}
                  </span>
                ),
              },
              {
                value: 'cards',
                label: (
                  <span className="seg-icon">
                    <LayoutGrid size={14} /> {t('pcs.viewCards')}
                  </span>
                ),
              },
            ]}
          />
          <Segmented
            value={zone}
            onChange={setZone}
            options={[{ value: 'all', label: `${t('pcs.all')} (${pcs.length})` }, ...zones.map((z) => ({ value: z, label: `${z} (${pcs.filter((p) => p.zone === z).length})` }))]}
          />
          <div className="search">
            <Search size={15} />
            <input className="input" placeholder={t('pcs.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => setScanOpen(true)}>
            <Radar size={16} /> {t('pcs.scanNetwork')}
          </button>
          <button
            className="btn primary"
            onClick={() => setEditor({ pc: { id: nextFreeId(pcs), ip: '', mac: '', zone: zone !== 'all' ? zone : 'Regular' }, originalId: null })}
          >
            <Plus size={16} /> {t('pcs.addPc')}
          </button>
        </div>
        <div className="toolbar-row selbar">
          <button className="select-all" onClick={() => (allVisible ? setSelected(new Set()) : setSelected(new Set([...selected, ...visible.map((p) => p.id)])))}>
            <CheckBox state={allVisible ? 'on' : someVisible ? 'partial' : 'off'} />
            {selIds.length ? t('pcs.selectedCount', { count: selIds.length }) : t('pcs.selectAll')}
          </button>
          <Menu
            down
            trigger={(open) => (
              <button className="btn small ghost" onClick={open}>
                {t('pcs.selectMenu')} <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => {
              const pick = (label: string, pred: (p: PcRecord) => boolean) => (
                <button
                  onClick={() => {
                    selectWhere(pred);
                    close();
                  }}
                >
                  {label}
                </button>
              );
              return (
                <>
                  {pick(t('pcs.allPcs'), () => true)}
                  {zones.map((z) => (
                    <span key={z}>{pick(t('pcs.zonePrefix', { zone: z }), (p) => p.zone === z)}</span>
                  ))}
                  <hr />
                  {pick(t('pcs.freePcs'), (p) => occupancyOf(runtimes[p.id]) === 'free')}
                  {pick(t('pcs.occupiedPcs'), (p) => occupancyOf(runtimes[p.id]) === 'occupied')}
                  {pick('Online', (p) => runtimes[p.id]?.link === 'online')}
                  {pick(t('pcs.offlineSleeping'), (p) => ['offline', 'sleeping'].includes(deriveDisplayStatus(runtimes[p.id])))}
                  {pick(t('pcs.withErrors'), (p) => deriveDisplayStatus(runtimes[p.id]) === 'error')}
                  <hr />
                  <button
                    onClick={() => {
                      setSelected(new Set());
                      close();
                    }}
                  >
                    {t('pcs.clearSelection')}
                  </button>
                </>
              );
            }}
          </Menu>
          <span className="divider-v" />
          <div className="btn-group">
            {bulk('wake', <Power size={14} />)}
            {bulk('test', <Play size={14} />)}
            {bulk('sleep', <Moon size={14} />)}
            {bulk('hibernate', <Snowflake size={14} />)}
            {bulk('shutdown', <PowerOff size={14} />)}
            {bulk('restart', <RotateCcw size={14} />)}
            {bulk('cancel', <CircleStop size={14} />)}
            {bulk('clean-logins', <LogOut size={14} />)}
            <button className="btn small" disabled={!selIds.length} onClick={() => setSteamFor(selIds)}>
              <KeyRound size={14} /> {t('pcs.steamLogin')}
            </button>
            <Menu
              down
              trigger={(open) => (
                <button className="btn small" disabled={!selIds.length} onClick={open}>
                  <Ellipsis size={14} /> {t('pcs.more')}
                </button>
              )}
            >
              {(close) => (
                <>
                  <button
                    onClick={() => {
                      close();
                      setQueueFor(selIds);
                    }}
                  >
                    <Layers size={15} /> {t('pcs.queueAction')}
                  </button>
                  <button
                    onClick={() => {
                      close();
                      setUpdateFor(selIds);
                    }}
                  >
                    <PackageOpen size={15} /> {t('pcs.updateAgentAction')}
                  </button>
                  <hr />
                  <button
                    onClick={() => {
                      close();
                      setDeployFor(selIds);
                    }}
                  >
                    <Terminal size={15} /> {t('pcs.deployAction')}
                  </button>
                </>
              )}
            </Menu>
          </div>
        </div>
      </div>

      {queueStatus && !dismissed.includes(`q:${queueStatus.startedAt}`) && (
        <RunBar
          title={`Черга обслуговування (${queueStatus.reason}, по ${queueStatus.concurrency})${queueStatus.active ? '' : ' — завершено'}`}
          active={queueStatus.active}
          counts={queueStatus.counts}
          onCancel={() => void api.cancelQueue()}
          onDismiss={() => setDismissed((d) => [...d, `q:${queueStatus.startedAt}`])}
        />
      )}
      {updateStatus && !dismissed.includes(`u:${updateStatus.startedAt}`) && (
        <RunBar
          title={`Оновлення агента до v${updateStatus.version}${updateStatus.active ? '' : ' — завершено'}`}
          active={updateStatus.active}
          counts={updateStatus.counts}
          onCancel={() => void api.cancelAgentUpdate()}
          onDismiss={() => setDismissed((d) => [...d, `u:${updateStatus.startedAt}`])}
        />
      )}

      {view === 'map' ? (
        <ClubMap
          pcs={pcs}
          runtimes={runtimes}
          settings={settings}
          selected={selected}
          visible={visibleIds}
          filterActive={zone !== 'all' || q !== ''}
          runStates={runStates}
          latestAgentVersion={latestAgent}
          onSelect={selectOnMap}
          onAction={request}
          onLogs={setLogPc}
          onDiag={setDiagPc}
          onEdit={openEditor}
          onAddPc={addPcAt}
          onSteamLogin={setSteamFor}
          onUpdateAgent={openUpdate}
        />
      ) : visible.length === 0 ? (
        <div className="empty">{pcs.length ? t('pcs.empty') : t('pcs.emptyList')}</div>
      ) : (
        groups.map((g) => (
          <section key={g.zone} className="zone-section">
            {zone === 'all' && (
              <div className="zone-head">
                {g.zone} <span className="dim">{g.pcs.length}</span>
                <span className="line" />
              </div>
            )}
            {zone !== 'all' && <div style={{ height: 12 }} />}
            <div className="grid">
              {g.pcs.map((pc) => (
                <PcCard
                  key={pc.id}
                  pc={pc}
                  rt={runtimes[pc.id]}
                  selected={selected.has(pc.id)}
                  runTime={scheduleLabel(settings, pc)}
                  alerts={settings.alerts}
                  latestAgentVersion={latestAgent}
                  runState={runStates[pc.id] ?? null}
                  onToggle={toggle}
                  onAction={request}
                  onLogs={setLogPc}
                  onDiag={setDiagPc}
                  onEdit={openEditor}
                  onUpdateAgent={openUpdate}
                />
              ))}
            </div>
          </section>
        ))
      )}
      {view === 'cards' && <div style={{ height: 24 }} />}
      </div>

      {logPcRecord && (
        <LogDrawer
          pc={logPcRecord}
          rt={runtimes[logPcRecord.id]}
          settings={settings}
          onSettingsSaved={onSettingsSaved}
          onClose={() => setLogPc(null)}
          onAction={request}
          onDiag={setDiagPc}
        />
      )}
      {diagPcRecord && <DiagDialog pc={diagPcRecord} rt={runtimes[diagPcRecord.id]} onClose={() => setDiagPc(null)} />}
      {deployFor && <DeployDialog pcIds={deployFor} runtimes={runtimes} settings={settings} onClose={() => setDeployFor(null)} />}
      {pinForAction && (
        <PinPromptModal
          onVerified={() => {
            const p = pinForAction;
            setPinForAction(null);
            void execute(p.action, p.ids, p.force);
          }}
          onClose={() => setPinForAction(null)}
        />
      )}
      {occupiedPrompt && (
        <Modal
          title={occupiedPrompt.busyIds.length === 1 ? `ПК №${occupiedPrompt.busyIds[0]} зайнятий гравцем` : `Зайняті гравцями: ${occupiedPrompt.busyIds.length} ПК`}
          icon={<User size={18} color="var(--occ)" />}
          onClose={() => setOccupiedPrompt(null)}
          footer={(() => {
            const p = occupiedPrompt;
            const free = p.ids.filter((id) => !p.busyIds.includes(id));
            const close = () => setOccupiedPrompt(null);
            return (
              <>
                <button className="btn" onClick={close}>
                  Скасувати
                </button>
                {free.length > 0 && (
                  <button
                    className="btn primary"
                    autoFocus
                    onClick={() => {
                      close();
                      void execute(p.action, free);
                    }}
                  >
                    Лише вільні ({free.length})
                  </button>
                )}
                <button
                  className="btn danger solid"
                  onClick={() => {
                    close();
                    runWithOptionalPin(p.action, p.ids, true);
                  }}
                >
                  Примусово{p.ids.length > 1 ? ` для всіх (${p.ids.length})` : ''}
                </button>
              </>
            );
          })()}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            {ACTIONS[occupiedPrompt.action].label} закриє Steam і гру — гравця буде викинуто. Зараз за цими ПК хтось є:
          </p>
          <ul className="occ-list">
            {occupiedPrompt.busyIds.map((id) => (
              <li key={id}>
                <strong>ПК №{id}</strong> — {occupancyText(runtimes[id])}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {scanOpen && (
        <ScanDialog
          pcs={pcs}
          settings={settings}
          onClose={() => setScanOpen(false)}
          onAdd={(ip, mac) => setEditor({ pc: { id: nextFreeId(pcs), ip, mac, zone: 'Regular' }, originalId: null })}
          onPcsChanged={setPcs}
        />
      )}
      {editor && (
        <PcEditor
          initial={editor.pc}
          originalId={editor.originalId}
          pcs={pcs}
          zones={zones}
          onClose={() => setEditor(null)}
          onSaved={(list, savedPc) => {
            const cb = editor.onCreated;
            setPcs(list);
            setEditor(null);
            if (savedPc && cb) cb(savedPc);
          }}
        />
      )}
      {updateFor && <AgentUpdateDialog pcIds={updateFor} runtimes={runtimes} onClose={() => setUpdateFor(null)} />}
      {queueFor && <QueueDialog pcIds={queueFor} pcs={pcs} settings={settings} onClose={() => setQueueFor(null)} />}
      {steamFor && <SteamLoginDialog pcIds={steamFor} defaultUser={settings.maintenance.update.steamUser} runtimes={runtimes} onClose={() => setSteamFor(null)} />}
      {confirm && (
        <ConfirmDialog
          title={`${ACTIONS[confirm.action].label}: ${confirm.ids.length === 1 ? `ПК №${confirm.ids[0]}` : `${confirm.ids.length} ПК`}`}
          text={
            <>
              <p style={{ marginTop: 0 }}>{ACTIONS[confirm.action].confirm}</p>
              {confirm.ids.length > 1 && <p className="dim">ПК: {confirm.ids.join(', ')}</p>}
              {occupiedAmong(confirm.ids).length > 0 && (
                <p style={{ color: 'var(--occ)', fontWeight: 600 }}>Зайняті гравцями: {occupiedAmong(confirm.ids).map((id) => `№${id}`).join(', ')}</p>
              )}
            </>
          }
          confirmLabel={ACTIONS[confirm.action].label}
          danger={ACTIONS[confirm.action].danger}
          onConfirm={() => runWithOptionalPin(confirm.action, confirm.ids, false)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
