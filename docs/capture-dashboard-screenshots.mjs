import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real dashboard, synthetic API. Never connect to the running bot or a provider.
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dashboard/dist');
const output = path.join(root, 'docs/images');
try { await access(path.join(dist, 'index.html')); }
catch { throw new Error('Build the dashboard first: npm --prefix dashboard run build'); }
await mkdir(output, { recursive: true });

const now = new Date('2026-10-12T10:30:00.000Z');
const base = 'http://127.0.0.1:5173';
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const watches = [
  { id: id(1), trainNumber: 'IC8110', departureTime: '19:33', origin: 'Poznań Gł.', destination: 'Warszawa Zach.', active: true, lastKnownStatus: 'SOLD_OUT', purchaseMode: 'notify' },
  { id: id(2), trainNumber: 'IC145', departureTime: '13:37', origin: 'Warszawa Zach.', destination: 'Poznań Gł.', active: false, lastKnownStatus: 'AVAILABLE_WITH_SEAT', purchaseMode: 'blik' },
  { id: id(3), trainNumber: 'EIC6110', departureTime: '19:40', origin: 'Poznań Gł.', destination: 'Warszawa Zach.', active: true, lastKnownStatus: 'SEARCH_FAILED', purchaseMode: 'notify' },
].map((watch) => ({
  ...watch, journeyUrl: 'https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-10-12',
  travelDate: '2026-10-12T00:00:00.000Z', travelClass: 2, passengers: 1,
  seatRequired: true, checkIntervalMinutes: 5, purchaseConsent: watch.purchaseMode === 'blik',
  lastCheckedAt: '2026-10-12T10:29:00.000Z', consecutiveErrors: watch.purchaseMode === 'blik' ? 0 : 1,
}));
const purchase = {
  id: id(4), watchId: id(2), state: 'WAITING_FOR_BLIK', passengerName: 'Demo Passenger',
  seatAssignment: 'Wagon 19, miejsce 33, Środek', price: '33,81 zł',
  expiresAt: '2026-10-12T10:42:00.000Z', acceptCodeUntil: '2026-10-12T10:39:00.000Z',
  errorMessage: null, intercityUrl: null, orderNumber: null,
  summaryScreenshotArtifactId: id(5), browserAvailable: true, deferredAt: null,
};
const errors = [{
  id: id(6), watchId: id(3), status: 'SEARCH_FAILED',
  message: 'Demo: search results did not finish loading before timeout.',
  createdAt: '2026-10-12T10:25:00.000Z', watch: watches[2],
  screenshotArtifactId: id(7), logArtifactId: id(8), diagnosticArtifactId: id(9),
}];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 },
    locale: 'en-GB', timezoneId: 'Europe/Warsaw', deviceScaleFactor: 1, serviceWorkers: 'block' });
  const failures = [];
  context.on('page', (page) => page.on('pageerror', (error) => failures.push(error.message)));
  const provider = await context.newPage();
  await provider.setViewportSize({ width: 800, height: 530 });
  await provider.setContent(`<!doctype html><html lang="pl"><meta charset="utf-8">
    <style>body{font:18px system-ui;color:#182557;background:#f5f7fb;margin:24px}
    main{background:white;padding:24px;border:1px solid #d9e2ec;border-radius:10px}
    small{color:#64748b}h1{font-size:24px}p{margin:12px 0}input{padding:12px;font-size:18px;border:1px solid #ccd5df;border-radius:6px}
    button{padding:14px 24px;background:#fa692a;border:0;border-radius:6px;color:white;font-weight:bold;font-size:18px}
    footer{margin-top:20px;display:flex;justify-content:space-between}</style>
    <main><small>DEMO · simulated Intercity payment page</small><h1>Płatność BLIK</h1>
    <p>IC145 · Warszawa Zach. → Poznań Gł.</p><p>12 października · 13:37 · 2 klasa</p>
    <p>Wagon 19, miejsce 33, Środek</p><p>Czas na zakup: 12:00</p>
    <label>Wpisz kod BLIK<br><input aria-label="Wpisz kod BLIK" placeholder="••••••"></label>
    <footer><strong>Do zapłaty: 33,81 zł</strong><button>PŁACĘ</button></footer></main></html>`);
  const image = await provider.screenshot({ type: 'png', mask: [provider.locator('input')] });
  const targets = await provider.locator('input, button').evaluateAll((elements) => elements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    return { id: `demo-element-${index}`, label: element.getAttribute('aria-label') || element.textContent,
      kind: element.tagName === 'INPUT' ? 'input' : 'click', sensitive: element.tagName === 'INPUT',
      x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const frame = { id: id(10), image: `data:image/png;base64,${image.toString('base64')}`, width: 800, height: 530, targets };
  await provider.close();
  const summary = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="270" viewBox="0 0 680 270">
    <rect width="680" height="270" fill="white"/><g font-family="sans-serif" fill="#182557">
    <text x="24" y="35" font-size="16" fill="#64748b">DEMO — simulated purchase summary</text>
    <text x="24" y="77" font-size="25" font-weight="bold">IC145 · 12 października · 13:37</text>
    <text x="24" y="119" font-size="22">Warszawa Zach. → Poznań Gł.</text>
    <text x="24" y="159" font-size="20">Wagon 19, miejsce 33 · 2 klasa</text>
    <path d="M24 185H656" stroke="#d9e2ec"/><text x="24" y="232" font-size="24">Do zapłaty: 33,81 zł</text></g></svg>`;

  async function dashboard(watchId, remote = false) {
    const page = await context.newPage();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    let controlling = false;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      // Never allow any unmatched request to fall through to the network.
      try {
        if (url.origin === base && (pathname === '/' || /^\/assets\/[\w.-]+$/.test(pathname))) {
          const file = pathname === '/' ? 'index.html' : pathname.slice(1);
          return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(path.join(dist, file)) });
        }
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External request blocked');
        if (pathname === '/watches') return json({ watches });
        if (pathname === '/errors') return json({ errors });
        const watch = watches.find((item) => pathname === `/watches/${item.id}` || pathname === `/watches/${item.id}/purchase`);
        if (watch) {
          if (pathname.endsWith('/purchase')) return json({ purchase: watch.id === purchase.watchId ? purchase : null, serverTime: now.toISOString(), accountBusy: watch.id === purchase.watchId });
          return json({ watch: { ...watch, availabilityChecks: [
            { id: id(11), checkedAt: watch.lastCheckedAt, status: watch.lastKnownStatus, durationMs: 18420 },
            { id: id(12), checkedAt: '2026-10-12T10:24:00.000Z', status: 'SOLD_OUT', durationMs: 15320 },
          ], notifications: [], errors: [], artifacts: [{ id: id(8), kind: 'log', label: 'check-log', createdAt: now.toISOString() }] } });
        }
        if (pathname === `/artifacts/${id(5)}`) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: summary });
        if (pathname === `/purchases/${purchase.id}/browser/frame`) return json({ frame, ownsControl: controlling, controlBusy: controlling, canControl: true, state: purchase.state });
        if (pathname === `/purchases/${purchase.id}/browser/control`) {
          controlling = route.request().method() !== 'DELETE';
          return json({ token: 'synthetic-controller', expiresAt: '2026-10-12T10:30:30.000Z' });
        }
        throw new Error(`No documentation fixture for ${pathname}`);
      } catch (error) {
        failures.push(error.message);
        await route.abort('blockedbyclient');
      }
    });
    if (remote) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?watch=${watchId}${remote ? '&view=intercity' : ''}`);
    await page.getByRole('heading', { name: remote ? 'Intercity — strona bota' : 'Watcher Management', exact: true }).waitFor();
    await page.getByText('Wagon 19, miejsce 33, Środek', { exact: true }).waitFor({ state: watchId === purchase.watchId ? 'visible' : 'hidden' });
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  async function capture(page, name) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, name), fullPage: true, animations: 'disabled' });
    console.log(`Captured docs/images/${name}`);
    await page.close();
  }
  const overview = await dashboard(id(1));
  await overview.setViewportSize({ width: 1600, height: 550 });
  await overview.getByRole('button', { name: 'Edit', exact: true }).click();
  await overview.getByRole('heading', { name: 'Recent checks', exact: true }).waitFor();
  await capture(overview, 'dashboard-watchers.png');

  const blik = await dashboard(id(2));
  await blik.getByText('Podgląd podsumowania zakupu', { exact: true }).click();
  const summaryImage = blik.getByRole('img', { name: 'Podsumowanie zakupu w Intercity', exact: true });
  await summaryImage.scrollIntoViewIfNeeded();
  await summaryImage.evaluate((element) => element.decode());
  await capture(blik, 'dashboard-blik.png');

  const errorPage = await dashboard(id(1));
  await errorPage.setViewportSize({ width: 1600, height: 350 });
  await errorPage.getByRole('button', { name: 'Errors', exact: true }).click();
  await errorPage.getByText(errors[0].message, { exact: true }).waitFor();
  await capture(errorPage, 'dashboard-errors.png');

  const mobile = await dashboard(id(2), true);
  await mobile.getByLabel(/Powiększenie obrazu/).selectOption('100');
  await mobile.getByRole('button', { name: 'Włącz sterowanie', exact: true }).click();
  await mobile.getByText('Sterujesz stroną bota. Kliknij element obrazu, aby go obsłużyć.', { exact: true }).waitFor();
  await mobile.getByRole('img', { name: 'Aktualna strona Intercity otwarta w bocie', exact: true }).evaluate((element) => element.decode());
  await capture(mobile, 'dashboard-remote-mobile.png');
  assert.deepEqual(failures, [], 'Screenshot capture encountered a page error or unmatched request');
} finally { await browser.close(); }
