````md
# PKP Intercity Seat Availability Monitor

A private automation tool for monitoring one or many selected PKP Intercity trains and notifying the user when a seat becomes available.

The main goal of this project is **not** to automatically buy tickets, but to detect seat availability as quickly as possible and notify the user through a reliable channel such as Telegram, email, push notification, or SMS.

---

## 1. Project Overview

PKP Intercity seats on popular routes often sell out, especially during weekends, holidays, and peak travel hours. Sometimes seats become available again when another passenger cancels a ticket or changes their reservation.

This project monitors selected train connections and checks whether a seat with a valid reservation becomes available.

When availability is detected, the system sends an immediate notification to the user with the relevant train details and a direct link to the PKP Intercity purchase flow.

The system must support **multiple watched trains at the same time**. Each watched train is stored as a separate monitoring task called a `watch`.

---

## 2. Main Use Case

The user wants to monitor one or more specific trains, for example:

```text
Watch 1:
From: Warszawa Centralna
To: Gdańsk Główny
Date: 2026-06-15
Train: EIP 3500
Class: 2nd class
Passengers: 1
Requirement: seat reservation available

Watch 2:
From: Warszawa Centralna
To: Kraków Główny
Date: 2026-06-15
Train: EIP 1302
Class: 2nd class
Passengers: 1
Requirement: seat reservation available
````

The bot checks every active watch periodically.

If no seat is available, the bot does nothing.

If a seat becomes available for any watched train, the bot sends a notification:

```text
🚆 Seat available!

Train: EIP 3500
Route: Warszawa Centralna → Gdańsk Główny
Date: 2026-06-15
Departure: 08:25
Class: 2nd class
Passengers: 1

Buy now:
https://www.intercity.pl/...
```

Each watched train has its own independent state, so notifications are deduplicated separately for every watch.

---

## 3. Project Scope

### In Scope

The project should support:

* Monitoring one or many selected PKP Intercity connections at the same time.
* Checking whether a seat is available for each watched train.
* Filtering by:

  * origin station,
  * destination station,
  * travel date,
  * train number,
  * departure time,
  * class,
  * number of passengers.
* Sending notifications when availability changes.
* Avoiding duplicate notifications per watched train.
* Storing monitored trains in a database.
* Storing availability check history.
* Running checks periodically in the background.
* Supporting manual purchase by the user.
* Handling temporary website errors gracefully.
* Saving screenshots or debug logs when checks fail.

### Out of Scope for MVP

The MVP should not include:

* Full automatic ticket purchase.
* Automatic payment handling.
* Bypassing CAPTCHA, anti-bot systems, or rate limits.
* Mass scraping.
* Public multi-user SaaS functionality.
* Storing card details or payment credentials.
* Ticket resale.
* Account sharing.
* Aggressive high-frequency checking.

---

## 4. Recommended Approach

The safest and most practical approach is:

```text
Monitor availability → send notification → user buys manually
```

Instead of:

```text
Monitor availability → automatically buy ticket → automatically pay
```

Automatic purchase is technically possible in some cases, but it is much more fragile and risky because it involves login sessions, payment gateways, bank authentication, BLIK, 3-D Secure, possible anti-bot systems, and potential terms-of-service issues.

The first version should focus on **fast and reliable notifications**, not automatic buying.

---

## 5. Technical Architecture

Recommended architecture:

```text
+----------------------+
| User configuration   |
| CLI / Web UI / JSON  |
+----------+-----------+
           |
           v
+----------------------+
| Watch repository     |
| Active train watches |
+----------+-----------+
           |
           v
+----------------------+
| Monitor scheduler    |
| Cron / queue worker  |
+----------+-----------+
           |
           v
+----------------------+
| Availability checker |
| Playwright / HTTP    |
+----------+-----------+
           |
           v
+----------------------+
| Result parser        |
| Seat available?      |
+----------+-----------+
           |
           v
+----------------------+
| State comparator     |
| Previous vs current  |
+----------+-----------+
           |
           v
+----------------------+
| Notification service |
| Telegram / Email     |
+----------+-----------+
           |
           v
+----------------------+
| User buys manually   |
| PKP Intercity site   |
+----------------------+
```

---

## 6. Technology Stack

### Recommended MVP Stack

```text
Language: TypeScript / Node.js
Browser automation: Playwright
Database: SQLite or PostgreSQL
Scheduler: node-cron / BullMQ / simple interval worker
Notifications: Telegram Bot API
Deployment: VPS / Raspberry Pi / Docker
```

### Alternative Python Stack

```text
Language: Python
Browser automation: Playwright for Python
Database: SQLite / PostgreSQL
Scheduler: APScheduler / Celery
Notifications: Telegram / Email
Deployment: VPS / Raspberry Pi / Docker
```

For this project, **Node.js + Playwright** is a very good choice because Playwright has excellent support for browser automation, network inspection, screenshots, retries, and debugging.

---

## 7. Core Concepts

### 7.1. Watch

A `watch` is a single monitored train connection.

Each watched train contains:

* route,
* date,
* train number,
* optional departure time,
* class,
* number of passengers,
* check interval,
* notification preferences,
* active/inactive status.

Example:

```json
{
  "id": "watch_001",
  "origin": "Warszawa Centralna",
  "destination": "Gdańsk Główny",
  "date": "2026-06-15",
  "trainNumber": "EIP 3500",
  "departureTime": "08:25",
  "travelClass": 2,
  "passengers": 1,
  "seatRequired": true,
  "checkIntervalMinutes": 3,
  "notificationChannel": "telegram",
  "active": true
}
```

---

### 7.2. Multiple Watches

The system must support multiple watches at the same time.

Example:

```json
{
  "checks": [
    {
      "origin": "Warszawa Centralna",
      "destination": "Gdańsk Główny",
      "date": "2026-06-15",
      "trainNumber": "EIP 3500",
      "travelClass": 2,
      "passengers": 1,
      "seatRequired": true,
      "intervalMinutes": 3
    },
    {
      "origin": "Warszawa Centralna",
      "destination": "Kraków Główny",
      "date": "2026-06-15",
      "trainNumber": "EIP 1302",
      "travelClass": 2,
      "passengers": 1,
      "seatRequired": true,
      "intervalMinutes": 5
    },
    {
      "origin": "Poznań Główny",
      "destination": "Wrocław Główny",
      "date": "2026-06-16",
      "trainNumber": "IC 76100",
      "travelClass": 2,
      "passengers": 2,
      "seatRequired": true,
      "intervalMinutes": 5
    }
  ]
}
```

Each watch should be processed independently.

The system should track:

* last known status per watch,
* last check time per watch,
* last notification time per watch,
* consecutive errors per watch.

This prevents one broken watch from stopping the whole monitor.

---

### 7.3. Scheduler

The scheduler is responsible for running availability checks periodically.

Example behavior:

```text
Every scheduler tick:
  - load all active watches
  - check which watches are due for checking
  - process due watches sequentially or with limited parallelism
  - save the result for each watch
  - compare current status with previous status
  - notify only if availability changed from unavailable to available
```

The scheduler should avoid checking too aggressively.

Recommended intervals:

```text
Private usage: every 2–5 minutes per watch
Safe default: every 5 minutes per watch
Avoid: every few seconds
```

Recommended parallelism:

```text
Default maximum parallel checks: 1
Optional maximum parallel checks: 2–3
Avoid: many parallel browser sessions
```

---

## 8. Availability Checking Strategies

There are two possible implementation strategies.

---

### 8.1. Strategy A: HTTP/API-Based Checking

This is the preferred strategy if the PKP Intercity website exposes usable internal API requests.

The bot would:

1. Send HTTP requests similar to the website.
2. Parse JSON responses.
3. Extract train and seat availability data.
4. Return a structured result.

Advantages:

* Faster.
* More stable.
* Lower resource usage.
* Easier to deploy without a visible browser.
* Easier to run multiple watches.

Disadvantages:

* Internal APIs may change.
* Authentication/session handling may be needed.
* Not officially supported for public usage.
* Request format may be complex.
* May violate terms if used improperly.

Example result:

```json
{
  "available": true,
  "trainNumber": "EIP 3500",
  "origin": "Warszawa Centralna",
  "destination": "Gdańsk Główny",
  "departureTime": "08:25",
  "arrivalTime": "11:10",
  "travelClass": 2,
  "seatReservationAvailable": true,
  "price": "169.00 PLN",
  "purchaseUrl": "https://www.intercity.pl/..."
}
```

---

### 8.2. Strategy B: Playwright Browser Automation

This is the most realistic MVP strategy.

The bot behaves like a normal user:

1. Opens the PKP Intercity website.
2. Enters origin station.
3. Enters destination station.
4. Selects date.
5. Searches for connections.
6. Finds the selected train.
7. Checks whether a seat is available.
8. Sends a notification if available.

Advantages:

* Easier to build without official API access.
* Works even if the site does not expose simple APIs.
* Can be debugged visually.
* Can take screenshots on errors.
* Good for a private MVP.

Disadvantages:

* Slower.
* More fragile.
* Layout changes may break selectors.
* Needs careful rate limiting.
* Browser sessions consume more resources.
* May require handling cookies, modals, and UI changes.

---

## 9. Recommended MVP Implementation

For MVP, use **Playwright browser automation**.

### MVP Flow

```text
1. Load all active watches from database.
2. For each due watch:
   1. Open PKP Intercity search page.
   2. Fill origin and destination.
   3. Select travel date.
   4. Run search.
   5. Locate train by number and optionally departure time.
   6. Check availability text/status.
   7. Normalize result.
   8. Save check result.
   9. Compare with previous known status.
   10. Send notification if seat is now available.
3. Repeat periodically.
```

For stability, the MVP should process watches sequentially first. Limited parallelism can be added later.

---

## 10. Data Model

### 10.1. `watches`

Stores user-defined monitored train connections.

```sql
CREATE TABLE watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  travel_date DATE NOT NULL,

  train_number TEXT,
  departure_time TIME,

  travel_class INTEGER NOT NULL DEFAULT 2,
  passengers INTEGER NOT NULL DEFAULT 1,

  seat_required BOOLEAN NOT NULL DEFAULT TRUE,

  check_interval_minutes INTEGER NOT NULL DEFAULT 5,
  active BOOLEAN NOT NULL DEFAULT TRUE,

  notification_channel TEXT NOT NULL DEFAULT 'telegram',
  notification_target TEXT,

  last_known_status TEXT,
  last_checked_at TIMESTAMP,
  last_notified_at TIMESTAMP,

  consecutive_errors INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

### 10.2. `availability_checks`

Stores every availability check result.

```sql
CREATE TABLE availability_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  watch_id UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,

  checked_at TIMESTAMP NOT NULL DEFAULT NOW(),

  status TEXT NOT NULL,
  available BOOLEAN NOT NULL,
  seat_available BOOLEAN,

  price TEXT,
  purchase_url TEXT,

  train_number TEXT,
  departure_time TIME,
  arrival_time TIME,

  raw_status TEXT,
  raw_payload JSONB,

  error_message TEXT,
  screenshot_path TEXT,

  duration_ms INTEGER
);
```

---

### 10.3. `notifications`

Stores sent notifications to avoid duplicates and keep history.

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  watch_id UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  availability_check_id UUID REFERENCES availability_checks(id) ON DELETE SET NULL,

  sent_at TIMESTAMP NOT NULL DEFAULT NOW(),

  channel TEXT NOT NULL,
  target TEXT,
  message TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'sent',
  error_message TEXT
);
```

---

## 11. Availability Status Model

The checker should normalize website results into a small set of internal statuses.

```ts
type AvailabilityStatus =
  | 'AVAILABLE_WITH_SEAT'
  | 'AVAILABLE_WITHOUT_SEAT'
  | 'SOLD_OUT'
  | 'TRAIN_NOT_FOUND'
  | 'SEARCH_FAILED'
  | 'UNKNOWN';
```

Recommended meaning:

| Status                   | Meaning                                                 |
| ------------------------ | ------------------------------------------------------- |
| `AVAILABLE_WITH_SEAT`    | Ticket can be bought and seat reservation is available. |
| `AVAILABLE_WITHOUT_SEAT` | Ticket may be available, but no guaranteed seat.        |
| `SOLD_OUT`               | No ticket available for selected connection.            |
| `TRAIN_NOT_FOUND`        | Search worked, but selected train was not found.        |
| `SEARCH_FAILED`          | Website check failed.                                   |
| `UNKNOWN`                | Result could not be parsed safely.                      |

For this project, only `AVAILABLE_WITH_SEAT` should trigger a high-priority notification by default.

---

## 12. Notification Logic

The bot should avoid sending the same alert repeatedly.

Notification state is tracked **per watch**.

Recommended logic:

```text
Previous status for watch_001: SOLD_OUT
Current status for watch_001: AVAILABLE_WITH_SEAT
Action: send notification
```

```text
Previous status for watch_001: AVAILABLE_WITH_SEAT
Current status for watch_001: AVAILABLE_WITH_SEAT
Action: do not send duplicate notification
```

```text
Previous status for watch_001: AVAILABLE_WITH_SEAT
Current status for watch_001: SOLD_OUT
Action: update state, no user notification needed
```

```text
Previous status for watch_001: SEARCH_FAILED
Current status for watch_001: AVAILABLE_WITH_SEAT
Action: send notification
```

```text
Previous status for watch_001: SOLD_OUT
Current status for watch_001: SOLD_OUT
Action: do nothing
```

If multiple watched trains become available during the same scheduler cycle, the system may send:

* one notification per train, or
* one grouped notification containing all newly available trains.

For MVP, one notification per train is simpler.

---

## 13. Telegram Notification Example

Telegram is the best notification channel for MVP because it is fast and simple.

Example message:

```text
🚆 Seat available!

Train: EIP 3500
Route: Warszawa Centralna → Gdańsk Główny
Date: 2026-06-15
Departure: 08:25
Arrival: 11:10
Class: 2
Passengers: 1

Buy now:
https://www.intercity.pl/...
```

Example grouped message:

```text
🚆 Seats available on 2 watched trains!

1. EIP 3500
Warszawa Centralna → Gdańsk Główny
2026-06-15, 08:25

2. EIP 1302
Warszawa Centralna → Kraków Główny
2026-06-15, 10:20

Open PKP Intercity and buy manually.
```

---

## 14. Configuration Example

A simple JSON configuration can be used for MVP before building a full UI.

```json
{
  "checks": [
    {
      "origin": "Warszawa Centralna",
      "destination": "Gdańsk Główny",
      "date": "2026-06-15",
      "trainNumber": "EIP 3500",
      "departureTime": "08:25",
      "travelClass": 2,
      "passengers": 1,
      "seatRequired": true,
      "intervalMinutes": 3
    },
    {
      "origin": "Warszawa Centralna",
      "destination": "Kraków Główny",
      "date": "2026-06-15",
      "trainNumber": "EIP 1302",
      "departureTime": "10:20",
      "travelClass": 2,
      "passengers": 1,
      "seatRequired": true,
      "intervalMinutes": 5
    }
  ],
  "notifications": {
    "telegram": {
      "enabled": true,
      "botToken": "TELEGRAM_BOT_TOKEN",
      "chatId": "TELEGRAM_CHAT_ID"
    }
  }
}
```

---

## 15. Environment Variables

Recommended `.env` file:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/intercity_monitor

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

CHECK_INTERVAL_MINUTES=5
MAX_PARALLEL_CHECKS=1
HEADLESS=true

PKP_BASE_URL=https://www.intercity.pl/
SCREENSHOTS_DIR=./screenshots
```

For a simple MVP using SQLite:

```env
DATABASE_URL=file:./data/intercity-monitor.db

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

CHECK_INTERVAL_MINUTES=5
MAX_PARALLEL_CHECKS=1
HEADLESS=true

SCREENSHOTS_DIR=./screenshots
```

---

## 16. Suggested Project Structure

```text
intercity-seat-monitor/
├── README.md
├── package.json
├── playwright.config.ts
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── data/
├── screenshots/
├── src/
│   ├── index.ts
│   ├── config/
│   │   └── env.ts
│   ├── db/
│   │   ├── client.ts
│   │   └── migrations/
│   ├── scheduler/
│   │   ├── scheduler.ts
│   │   └── queue.ts
│   ├── checker/
│   │   ├── intercityChecker.ts
│   │   ├── parser.ts
│   │   ├── stationInput.ts
│   │   └── types.ts
│   ├── notifications/
│   │   ├── telegramNotifier.ts
│   │   └── notificationService.ts
│   ├── watches/
│   │   ├── watchRepository.ts
│   │   ├── watchService.ts
│   │   └── types.ts
│   └── utils/
│       ├── logger.ts
│       ├── retry.ts
│       ├── sleep.ts
│       └── time.ts
└── tests/
    ├── parser.test.ts
    ├── notificationLogic.test.ts
    └── fixtures/
        ├── available-with-seat.html
        ├── available-without-seat.html
        ├── sold-out.html
        ├── train-not-found.html
        └── search-error.html
```

---

## 17. Playwright Checker Pseudocode

```ts
async function checkAvailability(watch: Watch): Promise<AvailabilityResult> {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage();

  const startedAt = Date.now();

  try {
    await page.goto('https://www.intercity.pl/', {
      waitUntil: 'networkidle',
    });

    await acceptCookiesIfVisible(page);
    await fillOrigin(page, watch.origin);
    await fillDestination(page, watch.destination);
    await selectDate(page, watch.travelDate);
    await submitSearch(page);

    await page.waitForSelector('[data-testid="connection-list"]', {
      timeout: 30000,
    });

    const trainCard = await findTrainCard({
      page,
      trainNumber: watch.trainNumber,
      departureTime: watch.departureTime,
    });

    if (!trainCard) {
      return {
        status: 'TRAIN_NOT_FOUND',
        available: false,
        seatAvailable: false,
        durationMs: Date.now() - startedAt,
      };
    }

    const parsed = await parseTrainCard(trainCard);

    return {
      ...parsed,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const screenshotPath = `screenshots/error-${watch.id}-${Date.now()}.png`;

    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    return {
      status: 'SEARCH_FAILED',
      available: false,
      seatAvailable: false,
      errorMessage: String(error),
      screenshotPath,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await browser.close();
  }
}
```

---

## 18. Scheduler Pseudocode

```ts
async function runSchedulerTick(): Promise<void> {
  const activeWatches = await watchRepository.findActiveWatches();

  const dueWatches = activeWatches.filter((watch) => {
    return isWatchDueForCheck(watch);
  });

  const queue = createLimitedConcurrencyQueue({
    concurrency: Number(process.env.MAX_PARALLEL_CHECKS || 1),
  });

  for (const watch of dueWatches) {
    queue.add(async () => {
      await processSingleWatch(watch);
    });
  }

  await queue.onIdle();
}

async function processSingleWatch(watch: Watch): Promise<void> {
  const result = await intercityChecker.checkAvailability(watch);

  const savedCheck = await availabilityRepository.saveCheck({
    watchId: watch.id,
    ...result,
  });

  const shouldNotify = shouldSendNotification({
    previousStatus: watch.lastKnownStatus,
    currentStatus: result.status,
  });

  await watchRepository.updateAfterCheck({
    watchId: watch.id,
    lastKnownStatus: result.status,
    lastCheckedAt: new Date(),
    consecutiveErrors:
      result.status === 'SEARCH_FAILED'
        ? watch.consecutiveErrors + 1
        : 0,
  });

  if (shouldNotify) {
    await notificationService.notifySeatAvailable({
      watch,
      result,
      availabilityCheckId: savedCheck.id,
    });

    await watchRepository.updateLastNotifiedAt(watch.id, new Date());
  }
}
```

---

## 19. Important Parser Rules

The parser should not rely on one fragile text value only.

It should check multiple signals, for example:

* button enabled/disabled,
* availability text,
* reservation status,
* warning messages,
* price visibility,
* train number,
* departure time,
* class selection,
* seat reservation messages.

Example normalized result:

```ts
interface AvailabilityResult {
  status: AvailabilityStatus;
  available: boolean;
  seatAvailable: boolean;
  trainNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
  price?: string;
  purchaseUrl?: string;
  rawStatus?: string;
  rawPayload?: unknown;
  errorMessage?: string;
  screenshotPath?: string;
  durationMs?: number;
}
```

---

## 20. Error Handling

The bot should handle:

* PKP Intercity website unavailable,
* slow page loading,
* station autocomplete not working,
* train not found,
* layout changes,
* network timeout,
* blocked session,
* cookie modal,
* unexpected language/version changes,
* no results for selected date,
* temporary maintenance,
* Playwright browser crash.

Recommended behavior:

```text
If one check fails:
  - store the error
  - save screenshot if possible
  - increment consecutive error counter for this watch
  - do not notify user unless repeated failures occur

If 3–5 checks fail in a row for the same watch:
  - notify user that monitoring for this specific watch may be broken

If one watch fails:
  - continue checking other watches
```

Failure of one watched train must not stop the whole monitor.

---

## 21. Rate Limiting

The bot should behave politely.

Recommended rules:

```text
Minimum check interval per watch: 2 minutes
Default check interval per watch: 5 minutes
Maximum parallel checks: 1–3
Random delay between checks: 5–30 seconds
Retry failed check: max 1 retry
```

Avoid:

```text
Checking every few seconds
Running many browsers in parallel
Monitoring hundreds of trains from one IP
Repeated login attempts
Bypassing CAPTCHA
Bypassing anti-bot systems
```

For a private MVP, the safest configuration is:

```text
MAX_PARALLEL_CHECKS=1
CHECK_INTERVAL_MINUTES=5
```

---

## 22. Deployment Options

### Option A: Local Machine

Good for testing.

```bash
npm install
npx playwright install
npm run dev
```

Pros:

* easiest to debug,
* visible browser mode possible,
* fast iteration.

Cons:

* only works when the computer is running.

---

### Option B: Raspberry Pi

Good for private usage.

Pros:

* low power consumption,
* can run 24/7,
* good enough for a small number of watches.

Cons:

* Playwright on ARM can require extra setup,
* browser automation may be slower.

---

### Option C: VPS

Best for reliable 24/7 operation.

Pros:

* stable,
* easy Docker deployment,
* good network,
* can monitor continuously.

Cons:

* monthly cost,
* needs basic server maintenance.

---

## 23. Docker Deployment

Example `Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

CMD ["npm", "start"]
```

Example `docker-compose.yml`:

```yaml
version: "3.9"

services:
  intercity-monitor:
    build: .
    container_name: intercity-seat-monitor
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./screenshots:/app/screenshots
```

---

## 24. Development Roadmap

### Phase 1: Research

Goal: understand how PKP Intercity search works.

Tasks:

* Open PKP Intercity website manually.
* Search for a few test connections.
* Inspect browser network requests.
* Check whether availability data appears in JSON responses.
* Identify whether HTTP-based checking is possible.
* If not, continue with Playwright UI automation.

Deliverable:

```text
Decision: HTTP API checker or Playwright checker
```

---

### Phase 2: MVP Checker

Goal: check one hardcoded connection.

Tasks:

* Create Playwright script.
* Open website.
* Fill route and date.
* Search connections.
* Find selected train.
* Parse availability.
* Print result to console.

Deliverable:

```bash
npm run check
```

Expected output:

```json
{
  "status": "SOLD_OUT",
  "available": false,
  "seatAvailable": false
}
```

or:

```json
{
  "status": "AVAILABLE_WITH_SEAT",
  "available": true,
  "seatAvailable": true,
  "trainNumber": "EIP 3500",
  "departureTime": "08:25",
  "price": "169.00 PLN"
}
```

---

### Phase 3: Notifications

Goal: send Telegram alert when a seat is available.

Tasks:

* Create Telegram bot using BotFather.
* Store bot token in `.env`.
* Get user chat ID.
* Implement `TelegramNotifier`.
* Send test notification.
* Connect notification logic to checker.

Deliverable:

```bash
npm run notify:test
```

---

### Phase 4: Persistent Watches

Goal: support multiple monitored trains.

Tasks:

* Add database.
* Create `watches` table.
* Create `availability_checks` table.
* Create `notifications` table.
* Load all active watches.
* Store check history.
* Track last known status per watch.
* Avoid duplicate alerts per watch.

Deliverable:

```text
Multiple active watches are checked periodically and independently.
```

---

### Phase 5: Scheduler

Goal: run checks automatically.

Tasks:

* Add scheduler.
* Respect per-watch interval.
* Prevent overlapping checks for the same watch.
* Add limited parallelism.
* Add retry logic.
* Add logging.

Deliverable:

```bash
npm start
```

The app runs continuously and checks all due watched trains in the background.

---

### Phase 6: Admin Interface

Optional.

Goal: manage watched trains more easily.

Options:

* CLI commands,
* simple web panel,
* Telegram commands,
* JSON file configuration.

Example Telegram commands:

```text
/watch Warszawa Centralna | Gdańsk Główny | 2026-06-15 | EIP 3500
/list
/remove watch_001
/pause watch_001
/resume watch_001
```

---

## 25. Example CLI Commands

Add a watch:

```bash
npm run watch:add \
  -- --origin "Warszawa Centralna" \
  --destination "Gdańsk Główny" \
  --date "2026-06-15" \
  --train "EIP 3500" \
  --departure "08:25" \
  --class 2 \
  --passengers 1
```

List watches:

```bash
npm run watch:list
```

Remove a watch:

```bash
npm run watch:remove -- --id watch_001
```

Pause a watch:

```bash
npm run watch:pause -- --id watch_001
```

Resume a watch:

```bash
npm run watch:resume -- --id watch_001
```

Run one manual check:

```bash
npm run check:once -- --id watch_001
```

---

## 26. Testing Strategy

### Unit Tests

Test:

* availability parser,
* status normalization,
* duplicate notification logic,
* multiple watch scheduling logic,
* date formatting,
* station matching,
* train number matching,
* departure time matching,
* error handling.

Example parser test:

```ts
describe('parseAvailabilityStatus', () => {
  it('detects available seat', () => {
    const result = parseAvailabilityStatus('Dostępne miejsca siedzące');

    expect(result.status).toBe('AVAILABLE_WITH_SEAT');
    expect(result.seatAvailable).toBe(true);
  });

  it('detects sold out train', () => {
    const result = parseAvailabilityStatus('Brak miejsc');

    expect(result.status).toBe('SOLD_OUT');
    expect(result.available).toBe(false);
  });
});
```

Example notification logic test:

```ts
describe('shouldSendNotification', () => {
  it('sends notification when seat becomes available', () => {
    const result = shouldSendNotification({
      previousStatus: 'SOLD_OUT',
      currentStatus: 'AVAILABLE_WITH_SEAT',
    });

    expect(result).toBe(true);
  });

  it('does not send duplicate notification when still available', () => {
    const result = shouldSendNotification({
      previousStatus: 'AVAILABLE_WITH_SEAT',
      currentStatus: 'AVAILABLE_WITH_SEAT',
    });

    expect(result).toBe(false);
  });
});
```

---

### Integration Tests

Test with mocked HTML snapshots:

```text
fixtures/
├── available-with-seat.html
├── available-without-seat.html
├── sold-out.html
├── train-not-found.html
└── search-error.html
```

This allows testing the parser without hitting the real PKP Intercity website.

---

### Manual Tests

Test real routes manually:

```text
Short-distance route with likely availability
Long-distance popular route
Sold-out weekend route
Train with only 1st class available
Train with no seat reservation
Train not found
Multiple watched trains at the same time
Website temporary failure
```

---

## 27. Logging

Use structured logs.

Example successful check:

```json
{
  "level": "info",
  "message": "Availability check completed",
  "watchId": "watch_001",
  "trainNumber": "EIP 3500",
  "status": "SOLD_OUT",
  "checkedAt": "2026-05-29T12:00:00Z",
  "durationMs": 12432
}
```

Example error log:

```json
{
  "level": "error",
  "message": "Availability check failed",
  "watchId": "watch_001",
  "error": "Timeout waiting for connection list",
  "screenshotPath": "screenshots/error-watch_001-1716980000.png"
}
```

Example scheduler log:

```json
{
  "level": "info",
  "message": "Scheduler tick completed",
  "activeWatches": 5,
  "dueWatches": 3,
  "checkedWatches": 3,
  "failedWatches": 0
}
```

---

## 28. Legal and Ethical Considerations

This project should be designed as a private helper tool, not as a large-scale scraping or resale platform.

Important principles:

* Do not overload PKP Intercity systems.
* Do not bypass security mechanisms.
* Do not bypass CAPTCHA or anti-bot protections.
* Do not create fake accounts.
* Do not automatically buy tickets at scale.
* Do not resell tickets.
* Prefer manual user confirmation for purchases.
* Use reasonable intervals and low request volume.
* Stop or slow down checks if the website returns errors or rate limiting signals.

The recommended version only sends notifications and lets the user purchase manually.

---

## 29. Why Automatic Purchase Is Not Recommended

Automatic purchase requires handling:

* login,
* sessions,
* selected passenger data,
* shopping cart,
* reservation timeout,
* payment gateway,
* 3-D Secure,
* BLIK confirmation,
* bank authorization,
* failed payments,
* refunds,
* ticket cancellation rules.

It also increases the risk of:

* broken purchases,
* duplicate purchases,
* invalid passenger data,
* blocked account,
* payment errors,
* terms-of-service issues.

Therefore, the first version should only notify the user.

---

## 30. Future Improvements

Possible future features:

* Telegram command interface.
* Web dashboard.
* Support for many watched trains.
* Support for alternative routes.
* Check nearby departure times.
* Check both 1st and 2nd class.
* Detect cheaper tickets.
* Detect seat type if available.
* Notify when price changes.
* Notify when any train on a route becomes available.
* Group notifications for multiple available trains.
* Add mobile push notifications.
* Add calendar integration.
* Add support for KOLEO or Bilkom as auxiliary data sources.
* Use official timetable data for station and train metadata.
* Add per-watch priority.
* Add temporary pause until a specific date/time.
* Add automatic cleanup for past watches.
* Add admin panel authentication.

---

## 31. Example MVP Acceptance Criteria

The MVP is complete when:

* User can define multiple watched trains.
* Each watched train is checked independently.
* Each watched train has its own last known status.
* Bot checks availability periodically.
* Bot detects the selected train by number and optionally departure time.
* Bot distinguishes:

  * available with seat,
  * available without guaranteed seat,
  * unavailable,
  * train not found,
  * check failed.
* Bot sends Telegram notification when a seat appears.
* Bot does not send duplicate notifications every cycle.
* Notifications are deduplicated per watched train.
* Bot stores check history.
* Failure of one watched train does not stop the whole monitor.
* Bot runs reliably for at least 24 hours.

---

## 32. Suggested MVP Milestones

### Milestone 1

Hardcoded Playwright script checks one connection and prints availability.

### Milestone 2

Script sends Telegram notification when available.

### Milestone 3

Configuration file supports multiple watches.

### Milestone 4

Database stores watches and check history.

### Milestone 5

Scheduler processes multiple watches independently.

### Milestone 6

Dockerized service runs continuously on VPS or Raspberry Pi.

---

## 33. Final Recommendation

The best version of this project is:

```text
Private PKP Intercity seat monitor
+ multiple watched trains
+ Playwright-based checker
+ Telegram notifications
+ manual ticket purchase
```

This gives most of the practical value while avoiding the complexity and risks of automatic ticket buying.

Automatic purchase can be considered later, but it should not be part of the first implementation.

```
```
