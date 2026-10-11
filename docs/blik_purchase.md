# BLIK checkout

## User flow

The dashboard offers two watcher modes: `notify` (default) and `blik`.
BLIK requires configured `INTERCITY_EMAIL` / `INTERCITY_PASSWORD` and explicit
`purchaseConsent`. Consent authorizes accepting the required e-IC and Moje IC
terms. The bot uses account passenger data and disables invoice and donation.

After detecting an assigned seat, the checker follows **PŁATNOŚĆ** directly from
the summary instead of adding the ticket to the cart. It transfers ownership
of the existing Playwright browser/context/page to the purchase manager.
The watcher is stopped in the same database transaction that creates its session.
The payment page must match the watched train, departure, date, route, class,
passenger count and assigned seat. Before submission, the bot rechecks booking
details, passenger and amount; changed details do not initiate a payment.
The summary's active payment button is selected separately from the disabled
progress-bar button with the same name. Passenger data is read on the payment
screen. Preparation failures appear in the check log and session error without
being replaced by a subsequent deferral error.
Hidden native radio/checkbox inputs are selected through their visible labels,
then their checked state is verified. The BLIK code field is awaited only after
the BLIK method has been selected.

After checkout is prepared, email links to `DASHBOARD_URL?watch=<watch ID>`.
The dashboard shows passenger, seat, price, deadline and status. The user supplies
a fresh six-digit code and clicks **Zapłać**. The bot submits it on the retained
Intercity page; the user authorizes the transaction in their banking app.
Only an explicit Intercity success message marks a purchase `PAID`.

## Deadlines and failure handling

The first reservation timer is read in the summary before seat polling and
screenshots. `expiresAt` can only shorten. `acceptCodeUntil` is the earlier of
12 minutes from reservation start and three minutes before the actual expiry.
Preparing checkout and delivering email use that same time budget.

At the code deadline, an idle checkout clicks **ZAPŁAĆ PÓŹNIEJ**. `DEFERRED`
requires explicit site confirmation; it is not a paid ticket and does not
guarantee more reservation time. Missing clocks never grant a new 15-minute
window: preparation attempts immediate deferral instead of waiting.

A submitted payment is not deferred or retried automatically. A timeout during
submission may still mean the payment reached the provider. The manager observes
the page, allowing a new code only after an explicit rejection with an editable
BLIK field and before `acceptCodeUntil`. If no result is confirmed by two minutes
after expiry, the session becomes `UNKNOWN`. Expired reservations with a pending
payment also become `UNKNOWN`, requiring order inspection.

On controlled shutdown, waiting sessions attempt deferral; pending payments become
`UNKNOWN`. Startup marks all formerly active sessions `UNKNOWN` and keeps their
watchers stopped. The dashboard requires confirmation that the user inspected
the Intercity order before resuming an unknown purchase. `reviewedAt` records
that acknowledgement without rewriting the historical result.

## State and concurrency

`PurchaseSession` records metadata and transitions separately from availability:

```text
PREPARING → WAITING_FOR_BLIK → PAYMENT_PENDING → PAID
                 ↑                  |
                 └── explicit rejection

WAITING_FOR_BLIK → DEFERRED / EXPIRED / FAILED
Active session lost or pending result unresolved → UNKNOWN
```

An account gate covers scheduler and manual checks. Checks run sequentially;
all other checks pause while checkout is active, and the scheduler wakes when
it finishes. Editing, deleting or resuming watchers is blocked while the account
is busy. A PostgreSQL partial unique index additionally prevents two active
purchase records. The runtime supports one backend process per configured account.

The browser remains server-side; opening or closing the dashboard has no effect
on it. BLIK codes exist only transiently in the request and browser input. They
are not stored in session records, logs, screenshots or diagnostic artifacts.
No payment-page screenshots or raw browser submission errors are captured.
Stored Intercity links omit query parameters; they open Intercity in the user's
own browser and do not transfer the server-side browser session.

## API

Watcher creation/update accepts `purchaseMode: "notify" | "blik"` and
`purchaseConsent: boolean`. Existing records migrate to notification mode.

`GET /watches/:id/purchase` returns:

```json
{
  "purchase": null,
  "serverTime": "2026-10-09T12:00:00.000Z",
  "accountBusy": false
}
```

For an existing session, `purchase` contains its state, passenger, seat, price,
`expiresAt`, `acceptCodeUntil`, error, and available order reference/Intercity link.
Responses use `Cache-Control: no-store`. The dashboard polls every two seconds
and calculates its countdown from server time rather than the user's wall clock.

`POST /purchases/:id/blik` accepts:

```json
{ "code": "012345", "attemptId": "33333333-3333-4333-8333-333333333333" }
```

Returns `202 { "accepted": true }` for an accepted submission; this is not a
payment confirmation. Repeating the same attempt never submits again. Malformed
codes/UUIDs return 400; expired, busy or unavailable sessions return 409. Browser
requests from origins outside the configured dashboard origin are rejected.
The existing API remains private and is not a public multi-user service.

`POST /watches/:id/resume` accepts `{ "acknowledgeUnknown": true }` after manual
inspection of an unknown order. Normal resume does not require a body.

## Notifications and setup

Waiting-session email contains the dashboard link, passenger, seat, amount and
deadline. Terminal transitions send outcome emails. Notification failures are
retried independently and never reopen checkout; Resend idempotency keys and
recorded notifications deduplicate sends.

Set `DASHBOARD_URL` to the address used by the user. Apply migrations with
`npm run db:deploy`, then start the long-running backend. Docker deploys migrations
on startup. `check:once` refuses active purchase sessions and BLIK watchers.

## Verification

```bash
npm run prisma:generate
npx prisma validate
npm test
npm run build
npm --prefix dashboard run build
npm run test:browser
```

Unit tests cover deadlines, submission idempotency, retries after rejection,
concurrency, expiry, notification isolation and graceful shutdown. Browser tests
exercise local Intercity HTML fixtures and the built dashboard against the real
HTTP handlers with an in-memory purchase repository. They do not contact a bank,
send emails or place real orders. Dashboard screenshots are written under
`runtime/artifacts/`.

Live Intercity verification is separate: a real watched connection must reach
payment, and actual result messages/selectors must be checked against that site.
A real BLIK payment requires the user's code and banking-app confirmation.
