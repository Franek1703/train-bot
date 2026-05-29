# Train Bot

Private PKP Intercity seat availability monitor.

The MVP watches configured train connections, checks whether a seat becomes
available, and sends a Resend email alert so the user can buy manually on the
PKP Intercity website.

This project does not buy tickets, log into accounts, bypass CAPTCHA, or handle
payments.

## Stack

- TypeScript / Node.js
- Playwright
- PostgreSQL / Prisma
- Resend email notifications
- JSON watch configuration

## Environment

Copy `.env.example` to `.env` and fill in the Resend and database values.

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/intercity_monitor
NOTIFICATION_CHANNEL=email
RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=Intercity Monitor <notifications@yourdomain.com>
EMAIL_TO=your@email.com
TIMEZONE=Europe/Warsaw
PKP_BASE_URL=https://www.intercity.pl/
WATCHES_CONFIG_PATH=./config/watches.json
CHECK_INTERVAL_MINUTES=5
MAX_PARALLEL_CHECKS=1
HEADLESS=true
SCREENSHOTS_DIR=./screenshots
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

## Watches

Create `config/watches.json` from `config/watches.example.json`.

```json
{
  "checks": [
    {
      "id": "warszawa-gdansk-eip-3500",
      "origin": "Warszawa Centralna",
      "destination": "Gdańsk Główny",
      "date": "2026-06-15",
      "trainNumber": "EIP 3500",
      "departureTime": "08:25",
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

Seat availability alerts are sent by email through Resend.

Each email includes the detection timestamp formatted in `TIMEZONE`, the train
details, and the Intercity purchase link.
