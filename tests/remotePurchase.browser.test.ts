import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PurchaseManager } from '../src/purchases/purchaseManager.js';
import { IntercityPaymentPage } from '../src/purchases/intercityPaymentPage.js';
import type { PurchaseRecord, PurchaseRepository, RemoteFrame } from '../src/purchases/types.js';
import { prisma } from '../src/db/client.js';
import { purchaseRepository } from '../src/purchases/purchaseRepository.js';

const fixture = vi.hoisted(() => ({ base: '', manager: null as PurchaseManager | null, record: null as PurchaseRecord | null,
  watch: { id: '55555555-5555-4555-8555-555555555555', configKey: 'remote-test', journeyUrl: 'https://ebilet.intercity.pl/wyszukiwanie',
    origin: 'Poznań Gł.', destination: 'Warszawa Zach.', travelDate: '2026-10-11T00:00:00Z', trainNumber: 'IC8112',
    departureTime: '15:27', travelClass: 2, passengers: 1, seatRequired: true, checkIntervalMinutes: 5,
    active: false, purchaseMode: 'blik', purchaseConsent: true, lastKnownStatus: 'AVAILABLE_WITH_SEAT', consecutiveErrors: 0 },
}));
vi.mock('../src/config/env.js', () => ({ env: { get DASHBOARD_URL() { return fixture.base; }, DASHBOARD_ORIGIN: '*' } }));
vi.mock('../src/purchases/index.js', () => ({ purchaseManager: new Proxy({}, {
  get(_target, key) { const manager = fixture.manager!; const value = Reflect.get(manager, key); return typeof value === 'function' ? value.bind(manager) : value; },
}) }));
vi.mock('../src/purchases/purchaseRepository.js', async (original) => process.env.TEST_DATABASE_URL ? await original() : ({
  latestPurchase: async () => fixture.record, reviewUnknownPurchase: vi.fn(),
}));
vi.mock('../src/watches/watchRepository.js', async (original) => process.env.TEST_DATABASE_URL ? await original() : ({
  findWatches: async () => [fixture.watch], findWatchById: async () => fixture.watch,
  findWatchDetails: async () => ({ ...fixture.watch, availabilityChecks: [], artifacts: [], notifications: [], errors: [] }),
  createWatch: vi.fn(), updateWatch: vi.fn(), deleteWatch: vi.fn(), setWatchActive: vi.fn(),
}));
vi.mock('../src/scheduler/scheduler.js', () => ({ processSingleWatch: vi.fn() }));
vi.mock('../src/errors/errorRepository.js', () => ({ listErrors: async () => [], getErrorById: vi.fn() }));
vi.mock('../src/artifacts/artifactRepository.js', () => ({ getArtifactById: vi.fn(), getPurchaseSummaryArtifactId: async () => null }));
import { handleRequest, normalizeApiError } from '../src/api/server.js';

const booking = 'NIEDZIELA, 11 PAŹDZIERNIKA<br>IC 8112<br>15:27 Poznań Gł.<br>18:22 Warszawa Zach.<br>1 pasażer<br>2 klasa<br>Wagon 9, miejsce 17';
const html = `<!doctype html><html lang="pl"><body style="font-family:sans-serif">
  <main id="checkout"><p>${booking}</p><p>Czas na zakup: 14:40</p>
    <button id="proceed" onclick="document.querySelector('#payment').hidden=false;this.hidden=true">PŁATNOŚĆ</button>
    <section id="payment" hidden>
      <label>Imię i nazwisko <input aria-label="Imię i nazwisko" value="Test Passenger"></label>
      <label><input type="checkbox">Akceptuję Regulamin e-IC</label>
      <label><input type="radio" name="method">BLIK</label>
      <input aria-label="Kod BLIK" placeholder="WPISZ KOD BLIK">
      <p>Do zapłaty<br>33,81 zł</p>
      <button id="pay" onclick="window.submissions=(window.submissions||0)+1;document.querySelector('#result').textContent='Potwierdź płatność w aplikacji bankowej'">ZAPŁAĆ</button>
      <button onclick="document.querySelector('#dialog').hidden=false">ZAPŁAĆ PÓŹNIEJ</button>
    </section>
  </main><p id="result"></p>
  <section id="dialog" role="dialog" hidden><h2>Zapłać później</h2>
    <p>Potwierdzenie płatności musi nastąpić w ciągu 15 minut od dokonania rezerwacji.</p>
    <button onclick="window.deferrals=(window.deferrals||0)+1;document.querySelector('#dialog').hidden=true;document.querySelector('#checkout').hidden=true;document.querySelector('#orders').hidden=false">PRZEJDŹ DO OCZEKUJĄCYCH NA PŁATNOŚĆ</button>
  </section>
  <section id="orders" hidden><h1>Oczekujące na płatność</h1><article>
    <p>${booking}</p><p>Numer zamówienia: ORDER-1</p><p>Czas na zakup: 14:59</p>
    <button onclick="document.querySelector('#orders').hidden=true;document.querySelector('#checkout').hidden=false">Zapłać</button>
  </article></section>
</body></html>`;

let server: Server;
let browser: Browser;
let provider: Page;
let phone: Page;
let desktop: Page;
let payment: IntercityPaymentPage;
let start: Date;

beforeAll(async () => {
  start = new Date(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  if (process.env.TEST_DATABASE_URL) {
    if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_blik_test')) throw new Error('Dedicated *_blik_test database required');
    await prisma.watch.create({ data: { ...fixture.watch, travelDate: new Date(fixture.watch.travelDate) } });
  }
  const repository: PurchaseRepository = process.env.TEST_DATABASE_URL ? {
    ...purchaseRepository,
    async create(...args) { fixture.record = await purchaseRepository.create(...args); return fixture.record; },
    async update(...args) { fixture.record = await purchaseRepository.update(...args); return fixture.record; },
    async claimAttempt(...args) { const result = await purchaseRepository.claimAttempt(...args); fixture.record = await purchaseRepository.get(args[0]); return result; },
  } : {
    async create(watchId, seatAssignment, expiresAt, acceptCodeUntil) {
      fixture.record = { id: '66666666-6666-4666-8666-666666666666', watchId, seatAssignment, expiresAt, acceptCodeUntil,
        availabilityCheckId: null, state: 'PREPARING', passengerName: null, price: null, attemptId: null,
        orderNumber: null, intercityUrl: null, errorMessage: null, deferredAt: null, createdAt: new Date(), updatedAt: new Date() };
      return { ...fixture.record };
    },
    async get() { return fixture.record ? { ...fixture.record } : null; },
    async update(_id, patch) { fixture.record = { ...fixture.record!, ...patch }; return { ...fixture.record }; },
    async claimAttempt(_id, attemptId, now) {
      if (!fixture.record || !['WAITING_FOR_BLIK', 'WAITING_AFTER_DEFERRAL'].includes(fixture.record.state) || fixture.record.acceptCodeUntil <= now) return false;
      fixture.record = { ...fixture.record, state: 'PAYMENT_PENDING', attemptId }; return true;
    },
  };
  fixture.manager = new PurchaseManager(repository);
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/provider') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    if (pathname === '/' || pathname.startsWith('/assets/')) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      void readFile(path.join(process.cwd(), 'dashboard/dist', file)).then((buffer) => {
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); response.end(buffer);
      }).catch(() => { response.writeHead(404); response.end(); });
    } else void handleRequest(request, response).catch((error) => {
      const result = normalizeApiError(error); response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: result.message }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fixture.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  provider = await browser.newPage({ viewport: { width: 1280, height: 900 } }); await provider.goto(`${fixture.base}/provider`);
  payment = new IntercityPaymentPage(provider, { close: async () => { await provider.close(); } } as unknown as Browser, 'Wagon 9, miejsce 17', {
    ...fixture.watch, travelDate: new Date(fixture.watch.travelDate),
  });
  await fixture.manager.prepare(fixture.watch.id, 'Wagon 9, miejsce 17', new Date(start.getTime() + 15 * 60_000), payment);
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  desktop = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  for (const client of [phone, desktop]) await client.route('http://127.0.0.1:3001/**', async (route) => {
    const url = new URL(route.request().url()); const result = await route.fetch({ url: `${fixture.base}${url.pathname}` }); await route.fulfill({ response: result });
  });
}, 30_000);

afterAll(async () => {
  await fixture.manager?.shutdown(); await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.env.TEST_DATABASE_URL) { await prisma.watch.deleteMany({ where: { id: fixture.watch.id } }); await prisma.$disconnect(); }
  vi.useRealTimers();
});

describe('Remote browser and deferred checkout through real HTTP handlers', () => {
  it('shares the retained page across devices, confirms the modal, resumes and submits BLIK exactly once', async () => {
    const id = fixture.record!.id;
    const request = (route: string, method = 'GET', token?: string, body?: unknown) => fetch(`${fixture.base}/purchases/${id}/browser/${route}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const foreign = await fetch(`${fixture.base}/purchases/${id}/browser/frame`, { headers: { Origin: 'https://unrelated.example' } });
    expect(foreign.status).toBe(403);
    const lease = await (await request('control', 'POST', undefined, {})).json() as { token: string };
    expect((await request('control', 'POST', undefined, {})).status).toBe(409);
    const frame = await (await request('frame', 'GET', lease.token)).json() as { frame: RemoteFrame };
    await request('frame'); // Another viewer must not invalidate the controller's frame.
    const codeTarget = frame.frame.targets.find((target) => target.label === 'Kod BLIK')!;
    const input = { kind: 'fill', frameId: frame.frame.id, targetId: codeTarget.id, text: '012345', attemptId: crypto.randomUUID() };
    expect((await request('action', 'POST', undefined, input)).status).toBe(409);
    expect((await request('action', 'POST', lease.token, input)).status).toBe(200);
    expect(await provider.getByLabel('Kod BLIK', { exact: true }).inputValue()).toBe('012345');
    expect((await request('action', 'POST', lease.token, { ...input, attemptId: crypto.randomUUID() })).status).toBe(409);
    expect(fixture.record!.state).toBe('WAITING_FOR_BLIK');
    await provider.getByLabel('Kod BLIK', { exact: true }).fill(''); payment.remote.invalidate();
    vi.setSystemTime(new Date(start.getTime() + 12 * 60_000)); await fixture.manager!.tick();
    expect(fixture.record).toMatchObject({ state: 'WAITING_AFTER_DEFERRAL', orderNumber: 'ORDER-1' });
    expect(fixture.record!.expiresAt.getTime()).toBeGreaterThan(start.getTime() + 26 * 60_000);
    expect(await provider.evaluate(() => (window as unknown as { deferrals: number }).deferrals)).toBe(1);
    expect(provider.isClosed()).toBe(false); expect(fixture.manager!.busy).toBe(true);
    expect((await request('control', 'PATCH', lease.token)).status).toBe(409);
    const link = `${fixture.base}/?watch=${fixture.watch.id}&view=intercity`;
    await phone.goto(link);
    await phone.getByRole('button', { name: 'Włącz sterowanie', exact: true }).click();
    await phone.getByText('Sterujesz stroną bota. Kliknij element obrazu, aby go obsłużyć.', { exact: true }).waitFor();
    await desktop.goto(link);
    await desktop.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).click();
    await desktop.getByText('Sterujesz stroną bota. Kliknij element obrazu, aby go obsłużyć.', { exact: true }).waitFor();
    await phone.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).click();
    const resumeResponse = phone.waitForResponse((response) => response.url().endsWith('/browser/action') && response.request().method() === 'POST');
    await phone.getByRole('button', { name: 'Element strony: Zapłać', exact: true }).click();
    const resumed = await resumeResponse;
    expect(await resumed.json()).toEqual({ ok: true });
    expect(fixture.record!.state).toBe('WAITING_FOR_BLIK');
    await phone.getByRole('button', { name: 'Element strony: Kod BLIK', exact: true }).click();
    await phone.getByLabel('Wpisz wartość pola', { exact: true }).fill('012345');
    await phone.getByRole('button', { name: 'Wpisz na stronie bota', exact: true }).click();
    await mkdir('runtime/artifacts', { recursive: true });
    await phone.screenshot({ path: 'runtime/artifacts/remote-intercity-phone.png', fullPage: true });
    // Simulate LAN HTTP where randomUUID is unavailable in the browser.
    await phone.evaluate(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
    await phone.getByRole('button', { name: 'Element strony: ZAPŁAĆ', exact: true }).click();
    await phone.getByText('Potwierdź płatność w aplikacji bankowej. Czekamy na wynik Intercity.', { exact: true }).waitFor();
    expect(fixture.record!.state).toBe('PAYMENT_PENDING');
    expect(await provider.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(1);
    expect(JSON.stringify(fixture.record)).not.toContain('012345');
    const duplicate = await fetch(`${fixture.base}/purchases/${id}/blik`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '012345', attemptId: fixture.record!.attemptId }) });
    expect(duplicate.status).toBe(202);
    await provider.locator('#result').evaluate((element) => { element.textContent = 'Płatność została zrealizowana. Numer zamówienia: ORDER-1'; });
    await fixture.manager!.tick();
    await phone.getByText('Zakup potwierdzony', { exact: true }).waitFor();
    expect((await request('frame')).status).toBe(410); expect(fixture.manager!.busy).toBe(false);
  }, 60_000);
});
