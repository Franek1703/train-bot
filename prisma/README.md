# Database

PostgreSQL persistence managed by Prisma. [schema.prisma](schema.prisma) defines
models; SQL in `migrations/` is applied in order. Connection settings are in
the [configuration guide](../config/README.md).

## Models

| Model | Stores |
| --- | --- |
| `Watch` | Journey, mode, consent, interval and latest status |
| `AvailabilityCheck` | Historical results, timing and diagnostics |
| `PurchaseSession` | State, seat, amount, deadlines, attempt/order IDs and review/deferral timestamps |
| `WatchArtifact` | File paths and artifact metadata |
| `WatchError` | Errors and references to diagnostic artifacts |
| `Notification` | Delivery audit and deduplication keys |

Artifact bytes live on disk, not in PostgreSQL. Watch deletion cascades records;
the application also removes that watcher's files. BLIK codes and browser/control
tokens are not stored in these models.

## Migrations

From the repository root with `DATABASE_URL` configured:

```bash
npm run prisma:generate
npm run db:deploy
```

Use `npm run db:migrate -- --name <change-name>` to create/apply a development
migration. Commit SQL and schema changes together. Docker generates the client
during build and deploys committed migrations on backend startup.

## Checkout lock and recovery

The SQL partial unique index `purchase_sessions_one_active_account` permits one
active checkout. Active states are `PREPARING`, `WAITING_FOR_BLIK`,
`WAITING_AFTER_DEFERRAL` and `PAYMENT_PENDING`. Preserve the index when changing
states; it is not represented as a normal Prisma model index. Purchase creation
and stopping the watcher share one transaction.

Payment attempts are claimed atomically before browser submission. `deferredAt`
prevents a second deferral; `reviewedAt` records inspection of an unknown outcome.
Startup marks formerly active sessions `UNKNOWN` and keeps their watchers stopped.
Database records cannot restore a lost browser.

Use a separate database for tests. See [PostgreSQL integration](../tests/README.md#postgresql-integration).
