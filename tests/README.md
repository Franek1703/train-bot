# Tests

Vitest covers watcher configuration/state, parsing, API schemas, notifications
and purchases. Browser suites use local providers; test codes never reach a bank.

## Unit tests

After `npm ci`, run from the repository root:

```bash
npm test
npm run build
```

Default tests exclude `*.browser.test.ts`. PostgreSQL cases are skipped unless
`TEST_DATABASE_URL` is set. Backend compilation checks TypeScript test files too.

## Browser tests

```bash
npm --prefix dashboard ci
npm --prefix dashboard run build
npm run test:browser
```

Root `npm ci` installs Firefox and Chromium through postinstall. If Linux system
libraries are missing, use `npx playwright install --with-deps firefox chromium`.

| Suite | Coverage |
| --- | --- |
| `intercityPaymentPage.browser.test.ts` | Local markup, terms, hidden choices, booking validation, PŁACĘ activation, remote Enter and uncertain clicks |
| `dashboardPurchase.browser.test.ts` | Built UI → HTTP handlers → manager, summary preview and result display |
| `remotePurchase.browser.test.ts` | Dashboard BLIK, phone/desktop takeover, retained deferral, reopening and idempotency |

Handlers and manager are real; Intercity and the bank are simulated. Without
PostgreSQL settings, integration uses an in-memory repository. Diagnostic images
go into ignored runtime storage. Documentation images use a separate
[capture script](../docs/README.md#regenerate-screenshots).

## PostgreSQL integration

Use a **separate** database ending in `_blik_test`. Both connection variables
must point to exactly the same URL; tests reject mismatched settings. With
Compose PostgreSQL already running:

```bash
docker compose exec postgres createdb -U postgres train_bot_blik_test
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/train_bot_blik_test
export TEST_DATABASE_URL="$DATABASE_URL"
npm run prisma:generate
npm run db:deploy
npx vitest run tests/purchaseRepository.postgres.test.ts tests/purchaseSummary.postgres.test.ts
npm --prefix dashboard run build
npm run test:browser
```

Create the database only once. Run repository and browser suites **sequentially**:
the database permits one active checkout. Browser files also run sequentially
when `TEST_DATABASE_URL` is set. Test watchers are removed afterwards. Use a fresh
terminal for development so test database settings do not carry over.

Coverage includes the checkout lock, rollback, concurrent claims, expiry,
retained deferral, restart recovery and purchase-specific summary artifacts.
Browser tests switch to real repositories with the test database configured;
the provider remains local. Real-site verification is separate and requires the
user's current BLIK code and banking-app confirmation for an actual payment.
