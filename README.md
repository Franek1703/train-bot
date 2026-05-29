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
