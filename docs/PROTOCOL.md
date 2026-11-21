# Протокол Admin Dashboard ↔ Client Agent (v1)

Типи всіх повідомлень визначені в одному місці — [`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts)
і [`types.ts`](../packages/protocol/src/types.ts). Їх використовують і адмінка, і агент, тож розійтися вони не можуть.

## Транспорт

| | |
|---|---|
| З'єднання | WebSocket, `ws://<IP ПК>:7420/` — **агент слухає**, адмінка підключається до кожного ПК |
| Кадри | текстові, один JSON-об'єкт на кадр, максимум 1 МБ |
| Живучість | адмінка шле WebSocket ping кожні 5 с; немає pong → з'єднання розривається (так швидко видно, що ПК заснув). Агент перевіряє своїх клієнтів кожні 15 с |
| Перепідключення | 2 → 4 → 8 → 15 с (далі кожні 15 с); після Wake-on-LAN — позачергова спроба через 20 с; при помилці ключа — раз на 30 с |
| Брандмауер | інсталятор агента відкриває TCP 7420 лише для `LocalSubnet` (або лише для IP адмінки, `-AdminIp`) і лише для `VadeAgent.exe` |

Чому агент — сервер: специфікація вимагає «агент слухає команди», адмінка знає всі IP з `pcs.json`,
а на головному ПК не треба відкривати вхідні порти.

## Рукостискання (взаємна автентифікація)

Спільний секрет — **ключ клубу** (32 випадкові байти, генерується адмінкою). Сам ключ мережею не передається.

```
агент  → адмін   { "t":"challenge", "nonce":A, "protocol":1 }
адмін  → агент   { "t":"auth", "nonce":B, "mac":HMAC(key,"vade/1|auth|A|B"), "client":"ADMIN-PC" }
агент  → адмін   { "t":"hello", "proof":HMAC(key,"vade/1|agent|B|A"), "info":{…}, "status":{…} }
```

* Агент перевіряє `mac` (порівняння за сталий час). Невірний — закриває з кодом `4001`.
* Адмінка перевіряє `proof`. Без нього підставний «агент» міг би виманити пароль Steam.
* Обидві сторони виводять **ключ сесії** `HMAC(key,"vade/1|session|A|B")`. Ним шифрується пароль Steam (AES-256-GCM).
* Немає `auth` за 5 с → закриття `4002`.

Коди закриття: `4001` невірний ключ · `4002` таймаут автентифікації · `4003` порушення протоколу ·
`4004` IP не в `allowFrom` · `4005` на агенті не налаштовано ключ.

## Запити й відповіді

```
адмін → агент  { "t":"req", "id":"17", "cmd":"job.start", "args":{ "mode":"test" } }
агент → адмін  { "t":"res", "id":"17", "ok":true, "result":{ "jobId":"a1b2c3d4e5f6" } }
агент → адмін  { "t":"res", "id":"18", "ok":false, "error":"Обслуговування вже виконується" }
агент → адмін  { "t":"res", "id":"19", "ok":false, "error":"ПК зайнятий гравцем: запущена гра (cs2.exe)", "code":"occupied" }
```

`code` — машинна причина помилки: `occupied` (адмінка пропонує «Лише вільні / Примусово»), `busy`, `hash_mismatch`, `not_service`.

| Команда | Аргументи | Результат | Примітка |
|---|---|---|---|
| `status.get` | `{}` | `AgentStatus` | |
| `config.apply` | `AgentConfigPayload` | `{ changed, nextRunAt }` | адмінка шле при кожному підключенні та після змін налаштувань; той самий `rev` → `changed:false` |
| `job.start` | `{ mode: "test" \| "manual" \| "scheduled", force?: boolean }` | `{ jobId }` | `test` ніколи не виконує дію після завершення. Якщо ПК зайнятий гравцем і `force` не задано — помилка з `code: "occupied"` |
| `job.cancel` | `{}` | `{ cancelled }` | SteamCMD зупиняється, junction гарантовано прибирається |
| `power` | `{ action: "sleep"\|"hibernate"\|"shutdown"\|"restart", delaySec }` | `PendingPower` | якщо йде завдання — спершу скасовується |
| `power.cancel` | `{}` | `{ cancelled }` | |
| `steam.login` | `{ user, password: SealedSecret, guardCode? }` | `SteamLoginResult` | до 150 с; `outcome`: `ok`, `invalid_password`, `guard_required`, `guard_mismatch`, `rate_limited`, `timeout`, `error` |
| `log.history` | `{ limit }` | `LogLine[]` | останні ≤1000 рядків з пам'яті агента |
| `session.clean` | `{ force?: boolean }` | `QuickCleanResult` `{ closed, removed, failed, ms, summary }` | швидке очищення після сесії (закрити програми, логіни Steam, сесії браузерів). Зайнятий ПК без `force` → `code: "occupied"` |
| `agent.selfUpdate` | `{ url, sha256, version }` | `{ message }` | агент завантажує файл, перевіряє sha256 (`code: "hash_mismatch"` → нічого не замінено), запускає помічника й перезапускає службу. Лише для встановленої служби (`code: "not_service"`), не під час завдання (`code: "busy"`) |

## Події агента

```
{ "t":"evt", "ev":"status", "data": AgentStatus }        // не частіше ніж раз на 300 мс
{ "t":"evt", "ev":"log", "data": { ts, level, msg, jobId? } }
{ "t":"evt", "ev":"power.pending", "data": { action, at } }
```

`level`: `info` · `warn` · `error` · `steam` (сирий вивід SteamCMD; прогрес — кожні 10 %).

## Основні структури

```ts
AgentConfigPayload = {
  rev: "9f3a12bc",            // хеш вмісту
  pcId: 12,
  maintenance: {              // глобальні налаштування + індивідуальні для ПК
    steamPath, steamcmdDir,
    cleanTemp, cleanSteamLogins, cleanSteamCache, cleanUserdata,
    workshop: { enabled, mode: "all"|"list", appIds },
    update:   { enabled, steamUser, mode: "auto"|"list", appIds, validate },
    after:    { action: "none"|"sleep"|"hibernate"|"shutdown", delaySec }
  },
  schedule: { enabled, runTime: "11:11", wakeLeadMin: 2, catchUpMin: 30 },
  detector: { enabled, idleMinutes: 10, gameProcesses: ["cs2.exe", …], senetProcesses: [], senetLockTitles: [] }
}                              // maintenance.skipIfOccupied: true — не стартувати вночі на зайнятому ПК

AgentStatus = {
  state: "idle"|"cleaning"|"updating"|"steam-login"|"powering",
  job: JobState|null, lastJob: JobState|null,
  nextRunAt, pendingPower, configRev, steamcmdInstalled, dryRun,
  occupancy: "free"|"occupied"|"unknown",          // з агента 0.2; старіші не надсилають
  occupancyReason: "game_running"|"senet_session"|"senet_locked"|"windows_locked"
                 |"active_input"|"idle"|"no_session"|"no_input_data"|"probe_failed"|"disabled",
  occupancyDetail: "cs2.exe · Player · без дій 0 хв",
  presence: { user, idleSec, locked, foreground, foregroundTitle, game? } | null,  // діагностика для адміна
  disks: [{ drive: "C:", freeBytes, totalBytes }],   // локальні фіксовані диски, раз на 60 с (агент 0.3+)
  quickCleanAt: ISO | null,                          // коли спрацює автоочищення після виходу клієнта
  lastQuickClean: { at, trigger: "auto"|"manual", ok, summary } | null
}
// AgentConfigPayload також містить postSessionClean: { enabled, delaySec, cleanSteamLogins, closeApps[], cleanBrowsers, browsers[] }

JobState = {
  id, mode, startedAt, finishedAt?, result?: "ok"|"errors"|"cancelled", errors,
  steps:    [{ id: "closeSteam"|"cleanTemp"|…|"update"|"after", status, note? }],
  apps:     [{ appId, name?, library, status: "pending"|"updating"|"ok"|"skipped_no_subscription"|"error"|"login_error", message? }],
  progress: { appId, pct, phase, doneBytes, totalBytes } | null
}
```

## Відображення статусів в адмінці

| Статус | Коли |
|---|---|
| **Online** | з'єднання є, агент вільний |
| **Cleaning** | іде будь-який крок, крім оновлення |
| **Updating** | працює SteamCMD (або вхід SteamCMD) |
| **Error** | останнє завдання завершилось з помилками, або ключ / версія протоколу не збігаються |
| **Sleeping** | з'єднання зникло після того, як агент оголосив сон / гібернацію |
| **Offline** | немає з'єднання |

Окремо від статусу картка показує бейдж **Вільний / Зайнятий / Невідомо** (поле `occupancy`).
Публічний статус для сайту описано в [SITE_INTEGRATION.md](SITE_INTEGRATION.md).

## Версіонування

`PROTOCOL_VERSION = 1` передається в `challenge`. Якщо версія інша, адмінка позначає ПК як `incompatible`
і нічого не надсилає. Нові необов'язкові поля додаються без зміни версії, несумісні зміни — з новою версією.
