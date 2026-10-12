# Backend

TypeScript backend combining a private HTTP API, scheduler, Playwright,
PostgreSQL and Resend. See the [project README](../README.md) for setup.

## Modules and entry points

| Module | Purpose |
| --- | --- |
| `api/` | HTTP routes, validation, CORS and payment origin checks |
| `checker/` | Search navigation, train selection, seat detection and check records |
| `scheduler/` | Due checks, account serialization, state changes and check logs |
| `watches/` | Watcher types, validation and database repository |
| `purchases/` | BLIK lifecycle, retained browser, deferral, remote control and emails |
| `notifications/` | Availability emails, delivery records and test email |
| `artifacts/` | Screenshot/log/diagnostic metadata, files and downloads |
| `errors/` | Error records and dashboard queries |
| `config/` | Environment validation and defaults |
| `db/` | Shared Prisma client |

`index.ts` recovers lost purchases, starts the API and runs the scheduler.
`checkOnce.ts` runs a forced notification-only tick; `notifyTest.ts` sends a real
test email. `npm run build` compiles to `dist/`; `npm start` runs
`dist/src/index.js`. Apply migrations separately outside Docker; `start:docker`
applies them before startup.

## Flow and concurrency

```text
Dashboard/API → PostgreSQL watcher → Scheduler → Intercity check
                                                ├─ Notification → Email
                                                └─ Retained BLIK checkout
                                                    → Dashboard code → PŁACĘ
                                                    → Bank confirmation → Outcome
```

The purchase manager gates all Intercity checks. An active purchase stops its
watcher and pauses other checks until its browser closes. A PostgreSQL partial
unique index additionally permits one active checkout. Browser actions, polling
and reservation inspection are serialized. Run one backend per account.
Headless checks use Firefox; headful checks use Chromium.

Deferral retains the browser; restart recovery marks formerly active purchases
`UNKNOWN` and keeps their watchers stopped. See [BLIK details](../docs/blik_purchase.md)
and the [database guide](../prisma/README.md).

## HTTP API

Default: `http://localhost:3001`. The API is private and has no user login.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Process health |
| GET / POST | `/watches` | List/create watchers |
| GET / PATCH / DELETE | `/watches/:id` | Details/update/delete |
| POST | `/watches/:id/stop` | Stop monitoring |
| POST | `/watches/:id/resume` | Resume; unknown purchases require `acknowledgeUnknown: true` |
| POST | `/watches/:id/check-now` | Manual availability check |
| GET | `/watches/:id/purchase` | Purchase, server clock and account busy state |
| POST | `/purchases/:id/blik` | Six-digit `code` and UUID `attemptId` |
| POST | `/purchases/:id/resume-payment` | Reopen the existing deferred order |
| GET | `/purchases/:id/browser/frame` | Masked image and available controls |
| POST / PATCH / DELETE | `/purchases/:id/browser/control` | Acquire/renew/release control |
| POST | `/purchases/:id/browser/action` | Validated click/input/select/scroll/key |
| GET | `/errors`, `/errors/:id` | Recorded errors |
| GET | `/artifacts/:artifactId` | Artifact download |

Watcher input uses `searchUrl`, `date` and `intervalMinutes`; responses use
`journeyUrl`, `travelDate` and `checkIntervalMinutes`. See [watcher input](../config/README.md#watcher-input).

Payment acceptance (`202`) is not purchase confirmation. Reusing an attempt ID
never submits again. Remote mutations require a controller bearer token; browser
origins are checked and sensitive responses are `no-store`. These controls do not
provide user authentication for Internet exposure. Request details are in
[BLIK API documentation](../docs/blik_purchase.md#api).
