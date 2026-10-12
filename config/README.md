# Configuration

Copy [`.env.example`](../.env.example) to `.env` at the repository root and fill
in your values. `.env` and `config/watches.json` are ignored by Git. The backend
validates settings in `src/config/env.ts`.

## Environment

These are backend defaults when omitted; `.env.example` and Compose can override them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL URL; Docker supplies its internal hostname |
| `RESEND_API_KEY` | Unset | Resend API key |
| `EMAIL_FROM` / `EMAIL_TO` | Unset | Sender and fallback recipient |
| `NOTIFICATION_CHANNEL` | `email` | Only supported channel |
| `INTERCITY_EMAIL` / `INTERCITY_PASSWORD` | Unset | Account credentials; required for BLIK |
| `TIMEZONE` | `Europe/Warsaw` | Notification timestamps |
| `PKP_BASE_URL` | `https://ebilet.intercity.pl/` | Legacy base setting; current checks navigate directly to the stored search URL |
| `CHECK_INTERVAL_MINUTES` | `5` | Scheduler wake interval; minimum two minutes |
| `MAX_PARALLEL_CHECKS` | `1` | Accepted setting; one-account checks are currently serialized |
| `HEADLESS` | `true` | Firefox when headless, Chromium when headful; headful requires a display |
| `SAVE_SCREENSHOTS` | `false` | Routine screenshots; BLIK summary capture remains required |
| `ADD_TO_CART` | `true` | Notification-mode cart behavior; BLIK goes directly to payment |
| `SCREENSHOTS_DIR` | `./runtime/artifacts` | Legacy setting; current screenshot capture uses `ARTIFACTS_DIR` |
| `ARTIFACTS_DIR` | `./runtime/artifacts` | Screenshots, check logs and diagnostics |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `3001` | API listener |
| `DASHBOARD_ORIGIN` | `http://localhost:5173` | CORS origin; Compose defaults to `*` |
| `DASHBOARD_URL` | `http://localhost:5173` | Email links and payment origin checks |
| `WATCHES_CONFIG_PATH` | `./config/watches.json` | Legacy loader setting; the running scheduler reads PostgreSQL |
| `VITE_API_BASE_URL` | Dashboard hostname, port `3001` | Frontend-only URL compiled into the dashboard |

Docker stores artifacts in `/app/runtime/artifacts` on a named volume. The
`SCREENSHOTS_DIR=./screenshots` entry in `.env.example` is a legacy setting;
current local capture uses `ARTIFACTS_DIR`. See
[Compose overrides](../docker-compose.yml).

For a phone, set `DASHBOARD_URL` to a LAN address such as
`http://192.168.1.100:5173`. Both dashboard and API ports must be reachable.
Backend settings require a restart, which loses live browser sessions. A compiled
`VITE_API_BASE_URL` change requires a dashboard rebuild.

## Watcher input

Create watchers in the dashboard or through `POST /watches`. They are stored in
PostgreSQL. [watches.example.json](watches.example.json) documents a legacy
`checks` wrapper; normal startup does not import it. Dates and train details in
examples must be replaced with your actual journey.

Example API body:

```json
{
  "searchUrl": "https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-10-12&swyj=5100081&sprzy=5100067&time=18%3A45&przy=0&ticket100=1990&polbez=0",
  "origin": "Poznań Gł.",
  "destination": "Warszawa Zach.",
  "date": "2026-10-12",
  "trainNumber": "IC8110",
  "departureTime": "19:33",
  "travelClass": 2,
  "passengers": 1,
  "seatRequired": true,
  "intervalMinutes": 5,
  "active": true,
  "purchaseMode": "notify",
  "purchaseConsent": false
}
```

Mode defaults to `notify`. BLIK uses `blik`, requires `purchaseConsent: true`
and uses account passenger data. Optional `notificationTarget` overrides
`EMAIL_TO`. Class must be 1 or 2, passenger count 1–9 and interval at least two
minutes. Search URL passengers/discounts must match the desired journey.
