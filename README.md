# Train Bot

Private PKP Intercity seat availability monitor.

The MVP watches configured PKP Intercity search URLs, selects the matching train
and class, checks whether a seat is assigned on the summary page, adds the
ticket to the cart, and sends a Resend email alert so the user can finish
payment manually.

This project does not complete payment, bypass CAPTCHA, or automatically buy the
ticket.

## Stack

- TypeScript / Node.js
- Playwright
- PostgreSQL / Prisma
- Resend email notifications
- DB-managed watcher API
- React dashboard

## Environment

Copy `.env.example` to `.env` and fill in the Resend and database values.

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/intercity_monitor
NOTIFICATION_CHANNEL=email
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=Intercity Monitor <notifications@yourdomain.com>
EMAIL_TO=your@email.com
TIMEZONE=Europe/Warsaw
PKP_BASE_URL=https://ebilet.intercity.pl/
INTERCITY_EMAIL=your_intercity_email
INTERCITY_PASSWORD=your_intercity_password
WATCHES_CONFIG_PATH=./config/watches.json
CHECK_INTERVAL_MINUTES=5
MAX_PARALLEL_CHECKS=1
HEADLESS=true
SCREENSHOTS_DIR=./screenshots
ARTIFACTS_DIR=./runtime/artifacts
API_HOST=0.0.0.0
API_PORT=3001
DASHBOARD_ORIGIN=http://localhost:5173
```

## Scripts

```bash
npm run dev
npm run build
npm start
npm test
npm run db:migrate
npm run check:once
npm run notify:test
```

## Docker

Run the full local stack:

```bash
docker compose up --build
```

Services:

- Dashboard: `http://localhost:5173`
- Bot API: `http://localhost:3001`
- Postgres: `localhost:5432`

The compose stack includes named volumes for Postgres data and watcher artifacts.
Watcher screenshots and per-check logs are stored in the bot artifact volume and
remain available in the dashboard until the watcher is deleted.

The bot container runs Prisma migrations on startup with `prisma migrate deploy`.

## Watches

Watchers are now managed through the API/dashboard and stored in Postgres.
`config/watches.example.json` remains as a reference for the fields needed to
create a watcher.

```json
{
  "checks": [
    {
      "id": "poznan-warszawa-ic-146",
      "searchUrl": "https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-05-31&swyj=5100081&sprzy=5100067&time=11%3A00&przy=0&sprzez=&ticket100=1010&ticket50=&polbez=0",
      "origin": "Poznań Główny",
      "destination": "Warszawa Zachodnia",
      "date": "2026-05-31",
      "trainNumber": "IC 146",
      "departureTime": "11:35",
      "travelClass": 2,
      "passengers": 1,
      "seatRequired": true,
      "intervalMinutes": 5,
      "active": true
    }
  ]
}
```

## Notifications

Seat availability alerts are sent by email through Resend after a seat is found
and the ticket is added to the cart.

Each email includes the detection timestamp formatted in `TIMEZONE`, the train
details, assigned seat, and the Intercity cart/summary link.

After a watcher reaches `AVAILABLE_WITH_SEAT` and the email is sent, the bot
automatically sets that watcher to inactive so it stops checking but remains
visible with its history in the dashboard.

## API

The bot API is local/private and has no authentication in this version.

```text
GET    /health
GET    /watches
POST   /watches
GET    /watches/:id
PATCH  /watches/:id
POST   /watches/:id/stop
POST   /watches/:id/resume
DELETE /watches/:id
POST   /watches/:id/check-now
GET    /errors
GET    /errors/:id
GET    /artifacts/:artifactId
```

Deleting a watcher also deletes its stored artifact files.
