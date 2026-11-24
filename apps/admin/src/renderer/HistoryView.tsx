import { AlertTriangle, CheckCircle2, History, Search, Shield, Unlock, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AdminRole, AuditAction, AuditEntry, JobHistoryEntry, PcRecord } from '@vade/protocol';
import { api } from './api';
import { fmtDateTime } from './format';
import { useI18n } from './i18n';
import { Segmented } from './ui';

interface Props {
  pcs: PcRecord[];
}

type HistoryTab = 'jobs' | 'audit';
type AuditGroup = 'all' | 'power' | 'maintenance' | 'repair' | 'diag' | 'deploy' | 'config' | 'shift' | 'role';
type RoleFilter = 'all' | AdminRole;

const AUDIT_ACTION_GROUP: Record<string, Exclude<AuditGroup, 'all'>> = {
  'pc.wol': 'power',
  'pc.shutdown': 'power',
  'pc.restart': 'power',
  'pc.sleep': 'power',
  'pc.hibernate': 'power',
  'pc.cancel_power': 'power',
  'pc.maintenance': 'maintenance',
  'pc.maintenance_cancel': 'maintenance',
  'pc.clean': 'maintenance',
  'pc.sync_time': 'maintenance',
  'pc.steam_login': 'maintenance',
  'queue.start': 'maintenance',
  'queue.cancel': 'maintenance',
  'games.install': 'maintenance',
  'games.uninstall': 'maintenance',
  'pc.repair_set': 'repair',
  'pc.repair_clear': 'repair',
  'pc.note_set': 'repair',
  'diag.kill': 'diag',
  'diag.restart_explorer': 'diag',
  'diag.screenshot': 'diag',
  'diag.notify': 'diag',
  'diag.restore_hz': 'diag',
  'diag.restart_launcher': 'diag',
  'deploy.exec': 'deploy',
  'deploy.file': 'deploy',
  'agent.update': 'deploy',
  'pc.save': 'config',
  'pc.delete': 'config',
  'settings.save': 'config',
  'settings.regen_key': 'config',
  'settings.pin_change': 'config',
  'map.save': 'config',
  'backup.export': 'config',
  'backup.import': 'config',
  'tv.save': 'config',
  'tv.publish': 'config',
  'tv.server_toggle': 'config',
  'shift.open': 'shift',
  'shift.close': 'shift',
  'role.unlock': 'role',
  'role.lock': 'role',
};

const AUDIT_ACTION_KEY: Record<string, string> = {
  'pc.wol': 'audit.action.pc.wol',
  'pc.shutdown': 'audit.action.pc.shutdown',
  'pc.restart': 'audit.action.pc.restart',
  'pc.sleep': 'audit.action.pc.sleep',
  'pc.hibernate': 'audit.action.pc.hibernate',
  'pc.cancel_power': 'audit.action.pc.cancel_power',
  'pc.maintenance': 'audit.action.pc.maintenance',
  'pc.maintenance_cancel': 'audit.action.pc.maintenance_cancel',
  'pc.clean': 'audit.action.pc.clean',
  'pc.sync_time': 'audit.action.pc.sync_time',
  'pc.steam_login': 'audit.action.pc.steam_login',
  'pc.save': 'audit.action.pc.save',
  'pc.delete': 'audit.action.pc.delete',
  'pc.repair_set': 'audit.action.pc.repair_set',
  'pc.repair_clear': 'audit.action.pc.repair_clear',
  'pc.note_set': 'audit.action.pc.note_set',
  'diag.kill': 'audit.action.diag.kill',
  'diag.restart_explorer': 'audit.action.diag.restart_explorer',
  'diag.screenshot': 'audit.action.diag.screenshot',
  'diag.notify': 'audit.action.diag.notify',
  'diag.restore_hz': 'audit.action.diag.restore_hz',
  'diag.restart_launcher': 'audit.action.diag.restart_launcher',
  'deploy.exec': 'audit.action.deploy.exec',
  'deploy.file': 'audit.action.deploy.file',
  'agent.update': 'audit.action.agent.update',
  'queue.start': 'audit.action.queue.start',
  'queue.cancel': 'audit.action.queue.cancel',
  'settings.save': 'audit.action.settings.save',
  'settings.regen_key': 'audit.action.settings.regen_key',
  'settings.pin_change': 'audit.action.settings.pin_change',
  'map.save': 'audit.action.map.save',
  'backup.export': 'audit.action.backup.export',
  'backup.import': 'audit.action.backup.import',
  'shift.open': 'audit.action.shift.open',
  'shift.close': 'audit.action.shift.close',
  'role.unlock': 'audit.action.role.unlock',
  'role.lock': 'audit.action.role.lock',
  'games.install': 'audit.action.games.install',
  'games.uninstall': 'audit.action.games.uninstall',
  'tv.save': 'audit.action.tv.save',
  'tv.publish': 'audit.action.tv.publish',
  'tv.server_toggle': 'audit.action.tv.server_toggle',
};

const AUDIT_GROUP_OPTIONS: Array<{ value: AuditGroup; labelKey: string }> = [
  { value: 'all', labelKey: 'audit.groupAll' },
  { value: 'power', labelKey: 'audit.groupPower' },
  { value: 'maintenance', labelKey: 'audit.groupMaintenance' },
  { value: 'repair', labelKey: 'audit.groupRepair' },
  { value: 'diag', labelKey: 'audit.groupDiag' },
  { value: 'deploy', labelKey: 'audit.groupDeploy' },
  { value: 'config', labelKey: 'audit.groupConfig' },
  { value: 'shift', labelKey: 'audit.groupShift' },
  { value: 'role', labelKey: 'audit.groupRole' },
];

function auditActionGroup(action: AuditAction): Exclude<AuditGroup, 'all'> {
  const mapped = AUDIT_ACTION_GROUP[action];
  if (mapped) return mapped;
  if (action.startsWith('diag.')) return 'diag';
  if (action.startsWith('deploy.')) return 'deploy';
  if (action.startsWith('shift.')) return 'shift';
  if (action.startsWith('role.')) return 'role';
  if (action.startsWith('queue.') || action.startsWith('games.')) return 'maintenance';
  return 'config';
}

function targetMatchesPc(target: string, pcIdStr: string): boolean {
  const clean = target.trim();
  if (clean === pcIdStr) return true;
  const match = /^(?:pc\s*)?(?:#|\u2116)?(\d+)$/i.exec(clean);
  return match ? match[1] === pcIdStr : false;
}

const MODE_LABEL = {
  scheduled: 'Нічний',
  manual: 'Ручний',
  test: 'Тест',
} as const;

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} хв ${s} с` : `${m} хв`;
}

export function HistoryView({ pcs }: Props) {
  const { t, locale } = useI18n();
  const tr = (key: string, params?: Record<string, string | number>) => t(key as never, params);
  const [tab, setTab] = useState<HistoryTab>('jobs');
  const [entries, setEntries] = useState<JobHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pcFilter, setPcFilter] = useState<string>('all');
  const [daysFilter, setDaysFilter] = useState<number>(14);
  const [onlyErrors, setOnlyErrors] = useState(false);

  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditGroup, setAuditGroup] = useState<AuditGroup>('all');
  const [auditPcFilter, setAuditPcFilter] = useState<string>('all');
  const [auditRoleFilter, setAuditRoleFilter] = useState<RoleFilter>('all');
  const [auditSearch, setAuditSearch] = useState('');

  useEffect(() => {
    let alive = true;
    void api.listHistory().then((list) => {
      if (alive) {
        setEntries(list);
        setLoading(false);
      }
    });
    const off = api.onHistoryChanged((list) => setEntries(list));
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void api.listAudit().then((list) => {
      if (alive) {
        setAuditEntries(list);
        setAuditLoading(false);
      }
    });
    const off = api.onAuditChanged((list) => setAuditEntries(list));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pcById = useMemo(() => new Map(pcs.map((p) => [p.id, p])), [pcs]);

  const problemPcs = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const map = new Map<number, { count: number; lastErrorAt: string; lastMs: number; apps: Set<string> }>();
    for (const e of entries) {
      if (e.result !== 'errors') continue;
      const ms = Date.parse(e.finishedAt || e.startedAt);
      if (!Number.isFinite(ms) || ms < cutoff) continue;
      let bucket = map.get(e.pcId);
      if (!bucket) {
        bucket = { count: 0, lastErrorAt: e.finishedAt || e.startedAt, lastMs: ms, apps: new Set() };
        map.set(e.pcId, bucket);
      }
      bucket.count++;
      if (ms > bucket.lastMs) {
        bucket.lastMs = ms;
        bucket.lastErrorAt = e.finishedAt || e.startedAt;
      }
      for (const a of e.errorApps) bucket.apps.add(a.name ? `${a.name} (${a.appId})` : String(a.appId));
    }
    return [...map.entries()]
      .filter(([, v]) => v.count >= 2)
      .map(([pcId, v]) => ({ pcId, errorCount: v.count, lastErrorAt: v.lastErrorAt, failedApps: [...v.apps] }))
      .sort((a, b) => b.errorCount - a.errorCount || a.pcId - b.pcId);
  }, [entries]);

  const filtered = useMemo(() => {
    const cutoff = daysFilter > 0 ? Date.now() - daysFilter * 86_400_000 : 0;
    return entries.filter((e) => {
      if (pcFilter !== 'all' && e.pcId !== Number(pcFilter)) return false;
      if (onlyErrors && e.result !== 'errors') return false;
      if (cutoff > 0) {
        const ms = Date.parse(e.finishedAt || e.startedAt);
        if (!Number.isFinite(ms) || ms < cutoff) return false;
      }
      return true;
    });
  }, [entries, pcFilter, daysFilter, onlyErrors]);

  const filteredAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    return auditEntries.filter((e) => {
      if (auditGroup !== 'all' && auditActionGroup(e.action) !== auditGroup) return false;
      if (auditRoleFilter !== 'all' && e.role !== auditRoleFilter) return false;
      if (auditPcFilter !== 'all' && !e.targets.some((tgt) => targetMatchesPc(tgt, auditPcFilter))) return false;
      if (q) {
        const actionKey = AUDIT_ACTION_KEY[e.action];
        const actionLabel = actionKey ? tr(actionKey).toLowerCase() : '';
        const matches =
          (e.operatorName ?? '').toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q) ||
          actionLabel.includes(q) ||
          e.targets.some((tgt) => tgt.toLowerCase().includes(q)) ||
          (e.details ?? '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [auditEntries, auditGroup, auditPcFilter, auditRoleFilter, auditSearch, t]);

  return (
    <div className="page">
      <div className="page-title" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <h1>{t('history.title')}</h1>
        <span className="dim">{t('history.subtitle')}</span>
        <span className="spacer" />
        <Segmented<HistoryTab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'jobs', label: tr('history.tabJobs') },
            { value: 'audit', label: tr('history.tabAudit') },
          ]}
        />
      </div>

      {tab === 'jobs' ? (
        <>
          <section className="section">
            <h2>
              {problemPcs.length > 0 ? <AlertTriangle size={17} color="var(--warn)" /> : <CheckCircle2 size={17} color="var(--ok)" />} Проблемні ПК (2+ помилки за останні 7 днів)
            </h2>
            {problemPcs.length === 0 ? (
              <div className="hint" style={{ marginBottom: 0 }}>
                Системних збоїв не виявлено — усі столи стабільні за останні 7 днів.
              </div>
            ) : (
              <div className="problem-grid">
                {problemPcs.map((p) => {
                  const rec = pcById.get(p.pcId);
                  return (
                    <button
                      key={p.pcId}
                      type="button"
                      className="problem-card"
                      onClick={() => setPcFilter(String(p.pcId))}
                      title="Фільтрувати таблицю за цим ПК"
                    >
                      <div className="problem-card-head">
                        <strong>ПК №{p.pcId}</strong>
                        {rec && <span className={`tag zone-${rec.zone}`}>{rec.zone}</span>}
                        <span className="spacer" />
                        <span className="badge st-error">{p.errorCount} помилок</span>
                      </div>
                      <div className="dim" style={{ fontSize: 12 }}>
                        Востаннє: {fmtDateTime(p.lastErrorAt)}
                      </div>
                      {p.failedApps.length > 0 && (
                        <div className="problem-apps" title={p.failedApps.join(', ')}>
                          {p.failedApps.slice(0, 3).join(', ')}
                          {p.failedApps.length > 3 ? ` (+${p.failedApps.length - 3})` : ''}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="section">
            <h2>
              <History size={17} /> Журнал завдань
            </h2>
            <div className="toolbar-row" style={{ margin: '8px 0 12px' }}>
              <select className="input" value={pcFilter} onChange={(e) => setPcFilter(e.target.value)}>
                <option value="all">Усі ПК ({entries.length})</option>
                {pcs.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    ПК №{p.id} ({p.zone})
                  </option>
                ))}
              </select>
              <select className="input" value={daysFilter} onChange={(e) => setDaysFilter(Number(e.target.value))}>
                <option value={1}>За 24 години</option>
                <option value={3}>За 3 дні</option>
                <option value={7}>За 7 днів</option>
                <option value={14}>За 14 днів</option>
                <option value={0}>Увесь збережений період</option>
              </select>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Лише помилки
              </label>
              <span className="spacer" />
              <span className="dim" style={{ fontSize: 12 }}>
                Показано записів: {filtered.length}
              </span>
            </div>

            {loading ? (
              <div className="dim">Завантаження…</div>
            ) : filtered.length === 0 ? (
              <div className="dim" style={{ padding: '16px 0' }}>
                Записів за вибраними фільтрами немає. Історія накопичується автоматично після завершення завдань обслуговування.
              </div>
            ) : (
              <div className="plan-wrap" style={{ maxHeight: 540 }}>
                <table className="plan">
                  <thead>
                    <tr>
                      <th>Завершено</th>
                      <th>ПК</th>
                      <th>Режим</th>
                      <th>Тривалість</th>
                      <th>Статус</th>
                      <th>Оновлено ігор</th>
                      <th>Помилки / деталі</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => {
                      const rec = pcById.get(e.pcId);
                      return (
                        <tr key={`${e.pcId}:${e.id}`}>
                          <td>{fmtDateTime(e.finishedAt, locale, t('common.todayTime'))}</td>
                          <td>
                            <strong>№{e.pcId}</strong> {rec ? <span className={`tag zone-${rec.zone}`}>{rec.zone}</span> : null}
                          </td>
                          <td>{MODE_LABEL[e.mode]}</td>
                          <td>{fmtDuration(e.durationSec)}</td>
                          <td>
                            <span className={`badge ${e.result === 'ok' ? 'st-online' : e.result === 'errors' ? 'st-error' : 'st-offline'}`}>
                              {e.result === 'ok' ? 'OK' : e.result === 'errors' ? `Помилок: ${e.errors}` : 'Скасовано'}
                            </span>
                          </td>
                          <td>{e.updatedApps}</td>
                          <td style={{ maxWidth: 340 }}>
                            {e.errorApps.length > 0 ? (
                              <span className="s-error" style={{ fontSize: 12 }}>
                                {e.errorApps.map((a) => `${a.name ?? a.appId}${a.message ? ` (${a.message})` : ''}`).join('; ')}
                              </span>
                            ) : e.result === 'errors' ? (
                              <span className="dim" style={{ fontSize: 12 }}>
                                Помилка кроку обслуговування (див. лог ПК)
                              </span>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="section">
          <h2>
            <Shield size={17} color="var(--accent)" /> {tr('audit.title')}
          </h2>
          <div className="toolbar-row" style={{ margin: '8px 0 12px' }}>
            <select
              className="input"
              value={auditGroup}
              onChange={(e) => setAuditGroup(e.target.value as AuditGroup)}
            >
              {AUDIT_GROUP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {tr(opt.labelKey)}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={auditPcFilter}
              onChange={(e) => setAuditPcFilter(e.target.value)}
            >
              <option value="all">{tr('audit.allPcs')}</option>
              {pcs.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {t('common.pcNum', { id: p.id })} ({p.zone})
                </option>
              ))}
            </select>
            <select
              className="input"
              value={auditRoleFilter}
              onChange={(e) => setAuditRoleFilter(e.target.value as RoleFilter)}
            >
              <option value="all">{tr('audit.allRoles')}</option>
              <option value="operator">{tr('audit.roleOperator')}</option>
              <option value="owner">{tr('audit.roleOwner')}</option>
            </select>
            <div className="search" style={{ minWidth: 210, flex: '1 1 220px', maxWidth: 320 }}>
              <Search size={14} />
              <input
                type="search"
                className="input"
                style={{ width: '100%' }}
                value={auditSearch}
                placeholder={tr('audit.searchPlaceholder')}
                onChange={(e) => setAuditSearch(e.target.value)}
              />
            </div>
            <span className="spacer" />
            <span className="dim" style={{ fontSize: 12 }}>
              {tr('audit.shownCount', { count: filteredAudit.length })}
            </span>
          </div>

          {auditLoading ? (
            <div className="dim">{tr('audit.loading')}</div>
          ) : filteredAudit.length === 0 ? (
            <div className="dim" style={{ padding: '16px 0' }}>
              {tr('audit.empty')}
            </div>
          ) : (
            <div className="plan-wrap" style={{ maxHeight: 580 }}>
              <table className="plan">
                <thead>
                  <tr>
                    <th>{tr('audit.colTime')}</th>
                    <th>{tr('audit.colActor')}</th>
                    <th>{tr('audit.colAction')}</th>
                    <th>{tr('audit.colTargets')}</th>
                    <th>{tr('audit.colDetails')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAudit.map((e) => {
                    const actionKey = AUDIT_ACTION_KEY[e.action];
                    const actionLabel = actionKey ? tr(actionKey) : e.action;
                    const isOwnerEntry = e.role === 'owner';
                    return (
                      <tr key={e.id}>
                        <td title={new Date(e.ts).toLocaleString(locale)}>
                          {fmtDateTime(e.ts, locale, t('common.todayTime'))}
                        </td>
                        <td>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span
                              className="badge"
                              style={
                                isOwnerEntry
                                  ? { color: 'var(--warn)', background: 'var(--warn-soft)' }
                                  : { color: 'var(--accent)', background: 'var(--accent-soft)' }
                              }
                            >
                              {isOwnerEntry ? <Unlock size={11} /> : <User size={11} />}
                              {isOwnerEntry ? tr('audit.roleOwner') : tr('audit.roleOperator')}
                            </span>
                            {e.operatorName ? (
                              <span>{e.operatorName}</span>
                            ) : (
                              <span className="dim">{tr('audit.unnamedOperator')}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <span>{actionLabel}</span>
                            <span className="mono dim" style={{ fontSize: 11 }}>
                              {e.action}
                            </span>
                          </div>
                        </td>
                        <td>
                          {e.targets.length === 0 ? (
                            <span className="dim">-</span>
                          ) : (
                            <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                              {e.targets.map((tgt, idx) => {
                                const numericId = Number(tgt);
                                const rec = Number.isInteger(numericId) ? pcById.get(numericId) : undefined;
                                return (
                                  <span
                                    key={`${tgt}:${idx}`}
                                    className={`tag ${rec ? `zone-${rec.zone}` : 'mono'}`}
                                    title={rec?.name ? `${rec.name} (${rec.zone})` : rec?.zone}
                                  >
                                    {rec ? t('common.pcNum', { id: rec.id }) : tgt}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td style={{ maxWidth: 340 }}>
                          {e.details ? <span>{e.details}</span> : <span className="dim">-</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
