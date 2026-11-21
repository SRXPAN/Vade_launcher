import { CalendarClock, Download, Eraser, Info, LogOut, Power, ShieldCheck, User } from 'lucide-react';
import {
  AFTER_ACTION_TITLES,
  BROWSER_IDS,
  BROWSER_TITLES,
  formatHHMM,
  isPcScheduled,
  orderQueue,
  pcRunMinute,
  resolveMaintenance,
  type AfterAction,
  type AppSettings,
  type PcRecord,
  type ScheduleMode,
} from '@vade/protocol';
import { api, errorText } from './api';
import { AppIdsInput } from './AppIdsInput';
import { NameListInput } from './NameListInput';
import { SaveBar } from './SaveBar';
import { Option, Segmented, Switch, useToast } from './ui';
import { useDraft } from './useDraft';

interface Props {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  pcs: PcRecord[];
  setPcs: (pcs: PcRecord[]) => void;
}

export function ScheduleView({ settings, onSaved, pcs, setPcs }: Props) {
  const toast = useToast();
  const { draft, update, dirty, reset, save, error, saving } = useDraft(settings, onSaved);
  const s = draft.schedule;
  const m = draft.maintenance;
  const dt = draft.detector;

  const togglePcSchedule = async (pc: PcRecord, on: boolean) => {
    const overrides = { ...pc.overrides };
    if (on) delete overrides.scheduleEnabled;
    else overrides.scheduleEnabled = false;
    try {
      const r = await api.savePc({ ...pc, overrides }, pc.id);
      if (r.ok) setPcs(r.pcs);
      else toast('error', r.errors.join('\n'));
    } catch (e) {
      toast('error', errorText(e));
    }
  };

  const scheduledCount = pcs.filter((p) => isPcScheduled(draft, p)).length;
  const queueOrder = orderQueue(
    pcs.filter((p) => isPcScheduled(draft, p) || !s.enabled),
    s.zoneOrder,
  );
  const ps = draft.postSessionClean;
  const lastStart = pcs.length ? formatHHMM(Math.max(...pcs.map((p) => pcRunMinute(s, p.id) ?? 0))) : '—';

  return (
    <div className="page">
      <div className="page-title">
        <h1>Розклад і завдання</h1>
        <span className="dim">замість club_night_sleep.bat</span>
      </div>
      {error && <div className="errors">{error}</div>}
      <div className="cols">
        <div>
          <section className="section">
            <h2>
              <CalendarClock size={17} /> Нічне обслуговування
            </h2>
            <div className="hint">
              {s.mode === 'queue'
                ? `О ${s.startTime} головний ПК формує чергу: одночасно обслуговуються ${s.maxConcurrentUpdates} ПК, щойно один завершив — стартує наступний. Вимкнені ПК отримують Wake-on-LAN, коли настає їхня черга.`
                : `ПК №N стартує о «час старту + (N − 1) × крок». Головний ПК шле Wake-on-LAN за ${s.wolLeadMin} хв до старту, а агент сам запускає завдання у свій час — навіть якщо адмінка вимкнена (ПК прокидається таймером RTC).`}
            </div>
            <Option title="Розклад увімкнено" on={s.enabled} onChange={(v) => update((d) => void (d.schedule.enabled = v))} />
            <div className="field" style={{ margin: '6px 0 10px' }}>
              <label>Режим (контроль навантаження на інтернет)</label>
              <Segmented<ScheduleMode>
                value={s.mode}
                onChange={(v) => update((d) => void (d.schedule.mode = v))}
                options={[
                  { value: 'staggered', label: `Кроком (+${s.stepMin} хв на ПК)` },
                  { value: 'queue', label: `Чергою (${s.maxConcurrentUpdates} одночасно)` },
                ]}
              />
            </div>
            {s.mode === 'queue' && (
              <div className="notice warn" style={{ marginBottom: 8 }}>
                <Info size={16} />
                <span>
                  У режимі черги ПК не запускають обслуговування самі: головний ПК з адмінкою має працювати вночі. Режим «кроком» працює й без
                  нього.
                </span>
              </div>
            )}
            <div className="inline-fields" style={{ marginTop: 6 }}>
              <div className="field">
                <label>{s.mode === 'queue' ? 'Старт черги' : 'Старт ПК №1'}</label>
                <input className="input" type="time" value={s.startTime} onChange={(e) => update((d) => void (d.schedule.startTime = e.target.value))} />
              </div>
              {s.mode === 'queue' ? (
                <>
                  <div className="field">
                    <label>Одночасно ПК (1–10)</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={10}
                      value={s.maxConcurrentUpdates}
                      onChange={(e) => update((d) => void (d.schedule.maxConcurrentUpdates = Number(e.target.value)))}
                    />
                  </div>
                  <div className="field" style={{ width: 230 }}>
                    <label>Порядок зон (по одній у рядку)</label>
                    <NameListInput value={s.zoneOrder} onChange={(v) => update((d) => void (d.schedule.zoneOrder = v))} rows={2} placeholder={'Stream\nRegular'} />
                    <span className="hint">Порожньо = за номером ПК.</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>Крок між ПК, хв</label>
                    <input className="input" type="number" min={0} max={60} value={s.stepMin} onChange={(e) => update((d) => void (d.schedule.stepMin = Number(e.target.value)))} />
                  </div>
                  <div className="field">
                    <label>WoL раніше на, хв</label>
                    <input className="input" type="number" min={1} max={15} value={s.wolLeadMin} onChange={(e) => update((d) => void (d.schedule.wolLeadMin = Number(e.target.value)))} />
                  </div>
                </>
              )}
              <div className="field">
                <label>Запізнення до, хв</label>
                <input className="input" type="number" min={0} max={240} value={s.catchUpMin} onChange={(e) => update((d) => void (d.schedule.catchUpMin = Number(e.target.value)))} />
                <span className="hint">ПК, що увімкнувся пізніше, ще виконає завдання.</span>
              </div>
            </div>
          </section>

          <section className="section">
            <h2>
              <User size={17} /> Детектор зайнятості
            </h2>
            <div className="hint">
              Агент кожні 10 с визначає, чи сидить за ПК гравець: запущена гра, вхід у SENET, блокування Windows, рух миші / клавіатура (без
              втручання в пам'ять ігор). Результат — бейдж «Вільний / Зайнятий» і статус для карти бронювання на сайті.
            </div>
            <Option title="Детектор увімкнено" on={dt.enabled} onChange={(v) => update((d) => void (d.detector.enabled = v))} />
            <Option
              title="Не переривати гравців уночі"
              desc={`Якщо ПК зайнятий, нічне обслуговування не стартує й Steam не закривається (у лозі агента: «Skipped: PC is occupied by a player»). Агент перевіряє ще ${s.catchUpMin} хв після слоту і запуститься, щойно ПК звільниться. Ручний запуск з адмінки попередить і дозволить примусово.`}
              on={m.skipIfOccupied}
              disabled={!dt.enabled}
              onChange={(v) => update((d) => void (d.maintenance.skipIfOccupied = v))}
            />
            {dt.enabled && (
              <div className="form-grid" style={{ marginTop: 6 }}>
                <div className="field">
                  <label>Без дій → «Вільний», хв</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={240}
                    value={dt.idleMinutes}
                    onChange={(e) => update((d) => void (d.detector.idleMinutes = Number(e.target.value)))}
                  />
                  <span className="hint">Час без миші й клавіатури (геймпад не враховується — для цього список ігор).</span>
                </div>
                <div className="field">
                  <label>Ігрові процеси (по одному в рядку)</label>
                  <NameListInput value={dt.gameProcesses} onChange={(v) => update((d) => void (d.detector.gameProcesses = v))} rows={5} />
                  <span className="hint">Будь-яка гра з папки Steam на передньому плані теж рахується.</span>
                </div>
                <div className="field">
                  <label>Процеси оболонки SENET</label>
                  <NameListInput value={dt.senetProcesses} onChange={(v) => update((d) => void (d.detector.senetProcesses = v))} rows={3} placeholder="порожньо = SENET не враховується" />
                </div>
                <div className="field">
                  <label>Заголовки екрана входу SENET</label>
                  <NameListInput value={dt.senetLockTitles} onChange={(v) => update((d) => void (d.detector.senetLockTitles = v))} rows={3} placeholder="порожньо = будь-яке вікно SENET спереду" />
                </div>
                <div className="field full">
                  <div className="notice">
                    <Info size={16} />
                    <span>
                      Назви процесу й вікна SENET найпростіше взяти з живого логу ПК (подвійний клік по картці), коли на ньому показано екран входу, —
                      там є кнопка «Це екран входу SENET».
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="section">
            <h2>План на ніч</h2>
            <div className="hint">
              {!s.enabled
                ? 'Розклад вимкнено — нічні запуски не відбуваються. Перемикачі нижче діють, коли розклад увімкнено.'
                : s.mode === 'queue'
                  ? `Черга о ${s.startTime}: ${scheduledCount} з ${pcs.length} ПК, по ${s.maxConcurrentUpdates} одночасно`
                  : `У розкладі ${scheduledCount} з ${pcs.length} ПК · останній старт о ${lastStart}`}
            </div>
            <div className="plan-wrap">
              <table className="plan">
                <thead>
                  <tr>
                    <th>ПК</th>
                    <th>Зона</th>
                    {s.mode === 'queue' ? (
                      <th>№ у черзі</th>
                    ) : (
                      <>
                        <th>WoL</th>
                        <th>Старт</th>
                      </>
                    )}
                    <th>Після</th>
                    <th style={{ textAlign: 'right' }}>У розкладі</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.mode === 'queue' ? orderQueue(pcs, s.zoneOrder) : pcs).map((pc) => {
                    const run = pcRunMinute(s, pc.id);
                    const on = isPcScheduled(draft, pc);
                    const position = queueOrder.findIndex((p) => p.id === pc.id);
                    return (
                      <tr key={pc.id} className={on ? '' : 'off'}>
                        <td>№{pc.id}</td>
                        <td>{pc.zone}</td>
                        {s.mode === 'queue' ? (
                          <td>{position >= 0 ? <strong>{position + 1}</strong> : '—'}</td>
                        ) : (
                          <>
                            <td>{run == null ? '—' : formatHHMM(run - s.wolLeadMin)}</td>
                            <td>
                              <strong>{run == null ? '—' : formatHHMM(run)}</strong>
                            </td>
                          </>
                        )}
                        <td>
                          {AFTER_ACTION_TITLES[resolveMaintenance(draft, pc).after.action]}
                          {pc.overrides?.afterAction && <span className="dim"> (інд.)</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Switch on={pc.overrides?.scheduleEnabled !== false} onChange={(v) => void togglePcSchedule(pc, v)} label={`ПК ${pc.id} у розкладі`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div>
          <section className="section">
            <h2>
              <Eraser size={17} /> Очищення
            </h2>
            <Option
              title="Windows TEMP"
              desc="C:\Users\*\AppData\Local\Temp і C:\Windows\Temp. Зайняті файли пропускаються."
              on={m.cleanTemp}
              onChange={(v) => update((d) => void (d.maintenance.cleanTemp = v))}
            />
            <Option
              title="Логіни Steam"
              desc="loginusers.vdf, ssfn*, local.vdf та AutoLoginUser / RememberPassword у реєстрі всіх користувачів Windows (неактивні профілі підвантажуються з NTUSER.DAT)."
              on={m.cleanSteamLogins}
              onChange={(v) => update((d) => void (d.maintenance.cleanSteamLogins = v))}
            />
            <Option
              title="Кеш Steam"
              desc="htmlcache, appcache, logs, dumps, depotcache і AppData\Local\Steam\htmlcache."
              on={m.cleanSteamCache}
              onChange={(v) => update((d) => void (d.maintenance.cleanSteamCache = v))}
            />
            <Option
              title="Steam userdata"
              desc="Видаляє локальні налаштування та конфіги гравців (userdata). Зазвичай вимкнено."
              on={m.cleanUserdata}
              onChange={(v) => update((d) => void (d.maintenance.cleanUserdata = v))}
            />
            <Option
              title="Майстерня Steam (Workshop)"
              desc="workshop\content, downloads, temp і appworkshop_*.acf у всіх бібліотеках Steam."
              on={m.workshop.enabled}
              onChange={(v) => update((d) => void (d.maintenance.workshop.enabled = v))}
            >
              <div className="radio-row">
                <label>
                  <input type="radio" checked={m.workshop.mode === 'all'} onChange={() => update((d) => void (d.maintenance.workshop.mode = 'all'))} /> Усі ігри
                </label>
                <label>
                  <input type="radio" checked={m.workshop.mode === 'list'} onChange={() => update((d) => void (d.maintenance.workshop.mode = 'list'))} /> Лише вказані
                  AppID
                </label>
              </div>
              {m.workshop.mode === 'list' && <AppIdsInput value={m.workshop.appIds} onChange={(ids) => update((d) => void (d.maintenance.workshop.appIds = ids))} placeholder="730" />}
            </Option>
          </section>

          <section className="section">
            <h2>
              <LogOut size={17} /> Після виходу клієнта
            </h2>
            <div className="hint">
              Коли ПК стає з «Зайнятий» на «Вільний», агент чекає {ps.delaySec} с (раптом клієнт лише докидає час) і за 2–3 с закриває програми та видаляє
              входи: наступний клієнт не потрапить у чужий Steam, FACEIT, Telegram Web чи Gmail. Кеш, ігри й Майстерня не чіпаються, SteamCMD не
              запускається.
            </div>
            <Option
              title="Швидке очищення після виходу клієнта"
              on={ps.enabled}
              onChange={(v) => update((d) => void (d.postSessionClean.enabled = v))}
            >
              <div className="inline-fields">
                <div className="field">
                  <label>Пауза, с</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={600}
                    value={ps.delaySec}
                    onChange={(e) => update((d) => void (d.postSessionClean.delaySec = Number(e.target.value)))}
                  />
                </div>
              </div>
            </Option>
            <Option
              title="Логіни Steam"
              desc="loginusers.vdf, ssfn*, local.vdf, AutoLoginUser / RememberPassword у реєстрі."
              on={ps.cleanSteamLogins}
              onChange={(v) => update((d) => void (d.postSessionClean.cleanSteamLogins = v))}
            />
            <Option
              title="Сесії браузерів"
              desc="Куки, збережені паролі, відкриті вкладки, Local/Session Storage та IndexedDB. Закладки, розширення й налаштування лишаються."
              on={ps.cleanBrowsers}
              onChange={(v) => update((d) => void (d.postSessionClean.cleanBrowsers = v))}
            >
              <div className="radio-row">
                {BROWSER_IDS.map((b) => (
                  <label key={b}>
                    <input
                      type="checkbox"
                      checked={ps.browsers.includes(b)}
                      onChange={(e) =>
                        update((d) => {
                          const set = new Set(d.postSessionClean.browsers);
                          if (e.target.checked) set.add(b);
                          else set.delete(b);
                          d.postSessionClean.browsers = BROWSER_IDS.filter((x) => set.has(x));
                        })
                      }
                    />{' '}
                    {BROWSER_TITLES[b]}
                  </label>
                ))}
              </div>
            </Option>
            <div className="field" style={{ marginTop: 6 }}>
              <label>Закривати програми (по одній у рядку)</label>
              <NameListInput value={ps.closeApps} onChange={(v) => update((d) => void (d.postSessionClean.closeApps = v))} rows={4} />
              <span className="hint">Процеси вибраних браузерів закриваються автоматично.</span>
            </div>
            <div className="notice warn" style={{ marginTop: 10 }}>
              <Info size={16} />
              <span>
                Без налаштованого SENET «Вільний» означає {draft.detector.idleMinutes} хв без миші й клавіатури. Якщо клієнти довго дивляться відео
                не торкаючись миші, збільште цей час у «Детекторі зайнятості» або налаштуйте екран входу SENET.
              </span>
            </div>
          </section>

          <section className="section">
            <h2>
              <Download size={17} /> Оновлення ігор через SteamCMD
            </h2>
            <Option
              title="Оновлювати ігри"
              desc="На місці, у всіх бібліотеках (C:, D: …) через тимчасовий NTFS junction — клієнт Steam одразу бачить ігри оновленими."
              on={m.update.enabled}
              onChange={(v) => update((d) => void (d.maintenance.update.enabled = v))}
            >
              <div className="field">
                <label>Клубний логін Steam</label>
                <input className="input" value={m.update.steamUser} onChange={(e) => update((d) => void (d.maintenance.update.steamUser = e.target.value))} />
              </div>
              <div className="radio-row">
                <label>
                  <input type="radio" checked={m.update.mode === 'auto'} onChange={() => update((d) => void (d.maintenance.update.mode = 'auto'))} /> auto — усі
                  встановлені ігри
                </label>
                <label>
                  <input type="radio" checked={m.update.mode === 'list'} onChange={() => update((d) => void (d.maintenance.update.mode = 'list'))} /> Лише AppID
                </label>
              </div>
              {m.update.mode === 'list' && <AppIdsInput value={m.update.appIds} onChange={(ids) => update((d) => void (d.maintenance.update.appIds = ids))} />}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Switch on={m.update.validate} onChange={(v) => update((d) => void (d.maintenance.update.validate = v))} label="Validate" />
                <span>
                  Validate <span className="dim">— перевірка цілісності файлів (повільно)</span>
                </span>
              </label>
              <div className="notice">
                <ShieldCheck size={16} />
                <span>
                  Пароль не зберігається. На кожному ПК один раз виконайте «Вхід SteamCMD» (вкладка «Комп'ютери»), далі SteamCMD використовує
                  кешований вхід, у т.ч. після Steam Guard.
                </span>
              </div>
            </Option>
          </section>

          <section className="section">
            <h2>
              <Power size={17} /> Після завершення
            </h2>
            <div className="form-grid">
              <div className="field">
                <label>Дія</label>
                <select className="input" value={m.after.action} onChange={(e) => update((d) => void (d.maintenance.after.action = e.target.value as AfterAction))}>
                  {(Object.keys(AFTER_ACTION_TITLES) as AfterAction[]).map((a) => (
                    <option key={a} value={a}>
                      {AFTER_ACTION_TITLES[a]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Затримка: {m.after.delaySec} с</label>
                <input
                  type="range"
                  min={30}
                  max={60}
                  step={5}
                  value={m.after.delaySec}
                  disabled={m.after.action === 'none'}
                  onChange={(e) => update((d) => void (d.maintenance.after.delaySec = Number(e.target.value)))}
                />
              </div>
            </div>
            <div className="notice" style={{ marginTop: 12 }}>
              <Info size={16} />
              <span>Тест-запуск із вкладки «Комп'ютери» ніколи не вимикає ПК. Для окремого ПК дію можна змінити в його картці.</span>
            </div>
          </section>

          <section className="section">
            <h2>Шляхи на ігрових ПК</h2>
            <div className="form-grid">
              <div className="field full">
                <label>Папка Steam</label>
                <input className="input mono" value={m.steamPath} onChange={(e) => update((d) => void (d.maintenance.steamPath = e.target.value))} />
              </div>
              <div className="field full">
                <label>Папка SteamCMD</label>
                <input className="input mono" value={m.steamcmdDir} onChange={(e) => update((d) => void (d.maintenance.steamcmdDir = e.target.value))} />
                <span className="hint">Якщо SteamCMD немає — агент завантажить його сам.</span>
              </div>
            </div>
          </section>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}
