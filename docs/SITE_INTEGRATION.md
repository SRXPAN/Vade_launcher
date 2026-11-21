# Інтеграція з сайтом клубу (карта бронювання)

Адмінка на головному ПК надсилає на сайт **публічні** статуси столів. Налаштування — вкладка
«Інтеграція з сайтом». Код — [`apps/admin/src/main/sitePublisher.ts`](../apps/admin/src/main/sitePublisher.ts).

## Запит

```
POST https://our-site.com/api/club-status
Content-Type: application/json
Authorization: Bearer <API Secret із налаштувань>
X-Vade-Event: change | heartbeat | test
User-Agent: VadeLauncher/<версія>
```

```json
{
  "updatedAt": "2026-11-21T14:30:00.000Z",
  "pcs": [
    { "id": 1, "zone": "Regular", "status": "free" },
    { "id": 2, "zone": "Regular", "status": "occupied" },
    { "id": 3, "zone": "Regular", "status": "maintenance" },
    { "id": 18, "zone": "Stream", "status": "offline" }
  ]
}
```

Передаються **лише** номер столу, зона і статус. IP, MAC-адреси, назви ПК, ключ клубу, логи, імена гравців
і заголовки вікон на сайт не потрапляють (це перевіряє тест `packages/protocol/test/site.test.ts`).

| `status` | Значення |
|---|---|
| `free` | агент на зв'язку, детектор: гравця немає |
| `occupied` | за ПК гравець. Сюди ж потрапляє стан «детектор не може визначити», щоб сайт не пропонував місце, яке може бути зайняте |
| `maintenance` | іде обслуговування, оновлення ігор, вхід SteamCMD або вимкнення |
| `offline` | ПК вимкнений, спить або агент недоступний |

Відповідь `2xx` вважається успіхом, будь-яка інша — помилкою. Після помилки запит повторюється через 30 с → 1 хв → 2 хв…
(не рідше, ніж heartbeat).

## Коли надсилається

| Подія | Коли |
|---|---|
| `change` | змінився публічний статус будь-якого ПК, або ПК додали / видалили / змінили йому зону. Зміни за `debounce` (2 с) об'єднуються в один запит. Внутрішні зміни (прогрес оновлення, логи, IP) запитів не породжують |
| `heartbeat` | якщо `heartbeatSec` (за замовчуванням 600 с = 10 хв) нічого не надсилалось — щоб сайт бачив свіжий `updatedAt` |
| `test` | кнопка «Тест підключення». Не рахується в ліміт; сайт може не зберігати такі дані |

Після запуску адмінки перший запит іде через ~15 с, щоб агенти встигли підключитися і сайт на мить не побачив усі ПК `offline`.

## Бюджет Cloudflare Free

KV на безкоштовному плані дозволяє **1000 записів на добу** (скидання о 00:00 UTC). Розрахунок за замовчуванням:

* heartbeat кожні 10 хв — 144 запити на добу;
* ліміт у налаштуваннях — 900 успішних запитів на добу (UTC), тож на зміни лишається ~750, тобто в середньому ~26 змін статусу на кожен із 29 ПК;
* коли ліміт вичерпано, адмінка не шле нічого до 00:00 UTC (видно на вкладці, лічильник переживає перезапуск).

Якщо змін багато, збільште `debounce` (наприклад, до 10–30 с) або переходьте на D1 / Durable Objects, де ліміти на записи значно вищі.

## Приклад приймача: Cloudflare Worker + KV

`wrangler.toml`:

```toml
name = "club-status"
main = "worker.js"
compatibility_date = "2026-11-01"
kv_namespaces = [{ binding = "CLUB_STATUS", id = "<id з `npx wrangler kv namespace create CLUB_STATUS`>" }]
```

Секрет (той самий, що в адмінці): `npx wrangler secret put VADE_TOKEN`

`worker.js`:

```js
const STATUSES = new Set(['free', 'occupied', 'maintenance', 'offline']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/club-status') return new Response('Not found', { status: 404 });

    // Карта бронювання читає статуси звідси (GET без токена).
    if (request.method === 'GET') {
      const data = await env.CLUB_STATUS.get('status');
      return new Response(data ?? '{"updatedAt":null,"pcs":[]}', {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=15',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    if (!(await safeEqual(request.headers.get('Authorization') ?? '', `Bearer ${env.VADE_TOKEN}`))) {
      return new Response('Unauthorized', { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }
    const updatedAt = Date.parse(body?.updatedAt);
    if (!Array.isArray(body?.pcs) || body.pcs.length > 500 || Number.isNaN(updatedAt)) {
      return new Response('Bad payload', { status: 400 });
    }
    // Зберігаємо лише очікувані поля, навіть якщо прийде щось зайве.
    const clean = {
      updatedAt: new Date(updatedAt).toISOString(),
      pcs: body.pcs
        .filter((p) => Number.isInteger(p?.id) && STATUSES.has(p?.status))
        .map((p) => ({ id: p.id, zone: String(p.zone ?? '').slice(0, 40), status: p.status })),
    };

    // "Тест підключення" перевіряє токен і формат, але не витрачає запис KV.
    if (request.headers.get('X-Vade-Event') === 'test') return Response.json({ ok: true, test: true, pcs: clean.pcs.length });

    await env.CLUB_STATUS.put('status', JSON.stringify(clean)); // 1 запис KV
    return Response.json({ ok: true });
  },
};

// Порівняння токена за сталий час (дайджести однакової довжини).
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
```

Для перевірки в адмінці вкажіть `https://club-status.<ваш-акаунт>.workers.dev/api/club-status` (або маршрут на домені сайту)
і натисніть «Тест підключення»: має прийти `HTTP 200`. Невірний токен дає `401`.

> KV — eventually consistent: у різних дата-центрах Cloudflare нове значення може з'явитися із затримкою до ~60 с.
> Для карти бронювання цього зазвичай досить.
