# Documentation

Start with the [project README](../README.md) for installation and daily use.

| Guide | Purpose |
| --- | --- |
| [Dashboard](../dashboard/README.md) | UI, remote controls and screenshot gallery |
| [Backend](../src/README.md) | Modules, lifecycle and HTTP routes |
| [Configuration](../config/README.md) | Environment and watcher input |
| [Database](../prisma/README.md) | Models, migrations and checkout lock |
| [Tests](../tests/README.md) | Unit, browser and isolated PostgreSQL tests |
| [BLIK checkout](blik_purchase.md) | Deadlines, states, deferral, remote APIs and recovery |
| [Original MVP design](mvp_documentation.md) | Historical design, not the current feature specification |

The MVP document records the original notification-only scope. Use the checkout
guide and current code for BLIK and remote-browser behavior.

## Regenerate screenshots

PNG images in `images/` show the actual dashboard with synthetic data. The remote
view contains a labeled simulated Intercity page. No existing account, database,
email settings or live purchase is used.

From the repository root:

```bash
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run build
node docs/capture-dashboard-screenshots.mjs
```

The script loads built assets through intercepted local requests, supplies fixed
API fixtures and captures watchers, an expanded BLIK summary, errors and mobile
browser control. Unrecognized requests fail locally, never reaching external
services. Clock, locale and timezone are fixed for repeatable output. Existing
images are replaced. Review each image and commit it with related README changes.

The ignored root `screenshots/` directory contains runtime diagnostics and is
separate from these documentation assets.
