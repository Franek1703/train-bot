import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PurchaseManager } from '../src/purchases/purchaseManager.js';
import type { PurchasePage, PurchaseRecord, PurchaseRepository } from '../src/purchases/types.js';
import { prisma } from '../src/db/client.js';
import { purchaseRepository } from '../src/purchases/purchaseRepository.js';

const fixture = vi.hoisted(() => ({
  base: '', manager: null as PurchaseManager | null, record: null as PurchaseRecord | null,
  checkId: '33333333-3333-4333-8333-333333333333',
  screenshotId: '44444444-4444-4444-8444-444444444444', screenshotPath: '', screenshotReady: false,
  watch: {
    id: '11111111-1111-4111-8111-111111111111', configKey: 'test', journeyUrl: 'https://ebilet.intercity.pl/wyszukiwanie',
    origin: 'Poznań Główny', destination: 'Warszawa Zachodnia', travelDate: '2026-10-11T00:00:00.000Z',
    trainNumber: 'IC 8112', departureTime: '15:27', travelClass: 2, passengers: 1, seatRequired: true,
    checkIntervalMinutes: 5, active: false, purchaseMode: 'blik', purchaseConsent: true,
    lastKnownStatus: 'AVAILABLE_WITH_SEAT', consecutiveErrors: 0,
  },
}));

vi.mock('../src/config/env.js', () => ({ env: {
  get DASHBOARD_URL() { return fixture.base; }, DASHBOARD_ORIGIN: '*',
} }));
vi.mock('../src/purchases/index.js', () => ({ purchaseManager: {
  get busy() { return fixture.manager?.busy ?? false; },
  submit: (id: string, code: string, attemptId: string) => fixture.manager!.submit(id, code, attemptId),
  browserAvailable: (id: string) => fixture.manager!.browserAvailable(id),
} }));
vi.mock('../src/purchases/purchaseRepository.js', async (importOriginal) => process.env.TEST_DATABASE_URL
  ? await importOriginal() : ({
    latestPurchase: async () => fixture.record,
    reviewUnknownPurchase: vi.fn(),
  }));
vi.mock('../src/watches/watchRepository.js', async (importOriginal) => process.env.TEST_DATABASE_URL
  ? await importOriginal() : ({
  findWatches: async () => [fixture.watch],
  findWatchById: async () => fixture.watch,
  findWatchDetails: async () => ({ ...fixture.watch, availabilityChecks: [], artifacts: [], notifications: [], errors: [] }),
  createWatch: vi.fn(), updateWatch: vi.fn(), deleteWatch: vi.fn(), setWatchActive: vi.fn(),
}));
vi.mock('../src/scheduler/scheduler.js', () => ({ processSingleWatch: vi.fn() }));
vi.mock('../src/errors/errorRepository.js', () => ({ listErrors: async () => [], getErrorById: vi.fn() }));
vi.mock('../src/artifacts/artifactRepository.js', async (importOriginal) => process.env.TEST_DATABASE_URL
  ? await importOriginal() : ({
    getPurchaseSummaryArtifactId: async (watchId: string, checkId: string | null) =>
      fixture.screenshotReady && watchId === fixture.watch.id && checkId === fixture.checkId ? fixture.screenshotId : null,
    getArtifactById: async (id: string) => id === fixture.screenshotId ? {
      filePath: fixture.screenshotPath, contentType: 'image/svg+xml',
    } : null,
  }));

import { handleRequest, normalizeApiError } from '../src/api/server.js';

let server: Server;
let browser: Browser;
let dashboard: Page;
let screenshotDirectory: string;
const submits = vi.fn(async (_code: string) => {});
let outcome: 'pending' | 'paid' = 'pending';

beforeAll(async () => {
  screenshotDirectory = await mkdtemp(path.join(tmpdir(), 'train-bot-summary-'));
  fixture.screenshotPath = path.join(screenshotDirectory, 'summary-test.svg');
  await writeFile(fixture.screenshotPath, `<svg xmlns="http://www.w3.org/2000/svg" width="650" height="250" viewBox="0 0 650 250">
    <rect width="650" height="250" fill="#fff"/><g fill="#172455" font-family="sans-serif" font-size="24">
    <text x="30" y="50">Podsumowanie zakupu — IC 8112</text><text x="30" y="100">Poznań Główny → Warszawa Zachodnia</text>
    <text x="30" y="150">Wagon 9, miejsce 17</text><text x="30" y="210">Do zapłaty: 33,81 zł</text></g></svg>`);
  if (process.env.TEST_DATABASE_URL) {
    const db = new URL(process.env.TEST_DATABASE_URL);
    if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || !db.pathname.endsWith('_blik_test')) {
      throw new Error('DATABASE_URL must equal TEST_DATABASE_URL and use a dedicated *_blik_test database');
    }
    await prisma.watch.create({ data: { ...fixture.watch, travelDate: new Date(fixture.watch.travelDate) } });
  }
  const repository: PurchaseRepository = process.env.TEST_DATABASE_URL ? {
    ...purchaseRepository,
    async create(...args) { fixture.record = await purchaseRepository.create(...args); return fixture.record; },
    async update(...args) { fixture.record = await purchaseRepository.update(...args); return fixture.record; },
    async claimAttempt(...args) {
      const claimed = await purchaseRepository.claimAttempt(...args);
      fixture.record = await purchaseRepository.get(args[0]);
      return claimed;
    },
  } : {
    async create(watchId, seatAssignment, expiresAt, acceptCodeUntil) {
      fixture.record = {
        id: '22222222-2222-4222-8222-222222222222', watchId, availabilityCheckId: null,
        state: 'PREPARING', passengerName: null, price: null, seatAssignment, expiresAt, acceptCodeUntil,
        attemptId: null, orderNumber: null, intercityUrl: null, errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
      };
      return { ...fixture.record };
    },
    async get(id) { return fixture.record?.id === id ? { ...fixture.record } : null; },
    async update(_id, patch) { fixture.record = { ...fixture.record!, ...patch }; return { ...fixture.record }; },
    async claimAttempt(_id, attemptId, now) {
      if (fixture.record?.state !== 'WAITING_FOR_BLIK' || fixture.record.acceptCodeUntil <= now) return false;
      fixture.record = { ...fixture.record, state: 'PAYMENT_PENDING', attemptId };
      return true;
    },
  };
  const paymentPage: PurchasePage = {
    async prepare() { return { passengerName: 'Test Passenger', price: '33,81 zł', intercityUrl: 'https://ebilet.intercity.pl/', expiresAt: new Date(Date.now() + 15 * 60_000) }; },
    submit: submits,
    async observe() { return { outcome, orderNumber: outcome === 'paid' ? 'TEST-ORDER' : undefined }; },
    async defer() { return { confirmed: true }; },
    async close() {},
  };
  fixture.manager = new PurchaseManager(repository);
  await fixture.manager.prepare(fixture.watch.id, 'Wagon 9, miejsce 17', new Date(Date.now() + 15 * 60_000), paymentPage);
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname.startsWith('/assets/')) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      void readFile(path.join(process.cwd(), 'dashboard/dist', file)).then((buffer) => {
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        response.end(buffer);
      }).catch(() => { response.writeHead(404); response.end(); });
    } else {
      void handleRequest(request, response).catch((error) => {
        const result = normalizeApiError(error);
        response.writeHead(result.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: result.message }));
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixture.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  dashboard = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await dashboard.route('http://127.0.0.1:3001/**', async (route) => {
    const url = new URL(route.request().url());
    const result = await route.fetch({ url: `${fixture.base}${url.pathname}` });
    await route.fulfill({ response: result });
  });
}, 30_000);

afterAll(async () => {
  await fixture.manager?.shutdown();
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.env.TEST_DATABASE_URL) {
    await prisma.watch.deleteMany({ where: { id: fixture.watch.id } });
    await prisma.$disconnect();
  }
  if (screenshotDirectory) await rm(screenshotDirectory, { recursive: true, force: true });
});

describe('Dashboard → real HTTP API → purchase manager → dashboard', () => {
  it('opens the watcher from the email URL, survives reload, submits BLIK and renders confirmed purchase', async () => {
    const errors: string[] = [];
    dashboard.on('pageerror', (error) => errors.push(error.message));
    await dashboard.goto(`${fixture.base}/?watch=${fixture.watch.id}`);
    await dashboard.getByText('Miejsce czeka — podaj kod BLIK', { exact: true }).waitFor();
    await dashboard.getByText('Zrzut podsumowania zakupu jest jeszcze niedostępny.', { exact: true }).waitFor();
    // The session can appear before the scheduler links its check and registers the image.
    fixture.screenshotReady = true;
    fixture.record = { ...fixture.record!, availabilityCheckId: fixture.checkId };
    if (process.env.TEST_DATABASE_URL) {
      await prisma.availabilityCheck.create({ data: { id: fixture.checkId, watchId: fixture.watch.id, status: 'AVAILABLE_WITH_SEAT', available: true } });
      await prisma.watchArtifact.create({ data: {
        id: fixture.screenshotId, watchId: fixture.watch.id, availabilityCheckId: fixture.checkId,
        kind: 'screenshot', label: 'summary-test.svg', filePath: fixture.screenshotPath, contentType: 'image/svg+xml',
      } });
      await prisma.purchaseSession.update({ where: { id: fixture.record.id }, data: { availabilityCheckId: fixture.checkId } });
    }
    expect(await dashboard.getByRole('button', { name: 'Check now', exact: true }).isEnabled()).toBe(false);
    expect(await dashboard.getByText('Test Passenger', { exact: true }).isVisible()).toBe(true);
    const edit = await fetch(`${fixture.base}/watches/${fixture.watch.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(edit.status).toBe(409);
    const deletion = await fetch(`${fixture.base}/watches/${fixture.watch.id}`, { method: 'DELETE' });
    expect(deletion.status).toBe(409);
    await dashboard.reload();
    await dashboard.getByLabel('Kod BLIK', { exact: true }).waitFor();
    await dashboard.getByLabel('Kod BLIK', { exact: true }).fill('012345');
    await dashboard.getByText('Podgląd podsumowania zakupu', { exact: true }).click();
    const summary = dashboard.getByRole('img', { name: 'Podsumowanie zakupu w Intercity', exact: true });
    await summary.waitFor();
    await dashboard.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('.purchase-summary-preview img');
      return image?.complete && image.naturalWidth > 0;
    });
    expect(await summary.getAttribute('src')).toContain(`/artifacts/${fixture.screenshotId}`);
    const fullImage = dashboard.getByRole('link', { name: 'Otwórz pełny zrzut w nowej karcie' });
    expect(await fullImage.getAttribute('href')).toContain(`/artifacts/${fixture.screenshotId}`);
    expect(await fullImage.getAttribute('target')).toBe('_blank');
    await mkdir('runtime/artifacts', { recursive: true });
    await dashboard.screenshot({ path: 'runtime/artifacts/dashboard-blik-summary-preview.png', fullPage: true });
    await dashboard.getByText('Podgląd podsumowania zakupu', { exact: true }).click();
    expect(await dashboard.getByLabel('Kod BLIK', { exact: true }).inputValue()).toBe('012345');
    await mkdir('runtime/artifacts', { recursive: true });
    await dashboard.screenshot({ path: 'runtime/artifacts/dashboard-blik-waiting.png', fullPage: true });
    await dashboard.getByLabel('Kod BLIK', { exact: true }).fill('012345');
    await dashboard.getByRole('button', { name: 'Zapłać 33,81 zł', exact: true }).click();
    await dashboard.getByText('Potwierdź płatność w aplikacji bankowej. Czekamy na wynik Intercity.', { exact: true }).waitFor();
    expect(submits).toHaveBeenCalledOnce();
    expect(submits).toHaveBeenCalledWith('012345');
    expect(fixture.record?.state).toBe('PAYMENT_PENDING');
    const secondCode = await fetch(`${fixture.base}/purchases/${fixture.record!.id}/blik`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '654321', attemptId: crypto.randomUUID() }),
    });
    expect(secondCode.status).toBe(409);
    expect(JSON.stringify(fixture.record)).not.toContain('012345');
    outcome = 'paid';
    await fixture.manager!.tick();
    await dashboard.getByText('Zakup potwierdzony', { exact: true }).waitFor();
    expect(await dashboard.getByText('TEST-ORDER', { exact: true }).isVisible()).toBe(true);
    await dashboard.screenshot({ path: 'runtime/artifacts/dashboard-blik-paid.png', fullPage: true });
    expect(errors).toEqual([]);
  });

  it('validates BLIK on the real API and returns an idempotent response for the previous attempt', async () => {
    const invalid = await fetch(`${fixture.base}/purchases/${fixture.record!.id}/blik`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '123', attemptId: crypto.randomUUID() }),
    });
    expect(invalid.status).toBe(400);
    const duplicate = await fetch(`${fixture.base}/purchases/${fixture.record!.id}/blik`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '012345', attemptId: fixture.record!.attemptId }),
    });
    expect(duplicate.status).toBe(202);
    expect(submits).toHaveBeenCalledOnce();
    const otherOrigin = await fetch(`${fixture.base}/purchases/${fixture.record!.id}/blik`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
      body: JSON.stringify({ code: '012345', attemptId: crypto.randomUUID() }),
    });
    expect(otherOrigin.status).toBe(403);
    const poll = await fetch(`${fixture.base}/watches/${fixture.watch.id}/purchase`);
    expect(poll.headers.get('cache-control')).toBe('no-store');
    expect(await poll.json()).toMatchObject({ purchase: { state: 'PAID' }, accountBusy: false });
  });

  it('requires explicit review of an unknown order before resume', async () => {
    fixture.record = { ...fixture.record!, state: 'UNKNOWN' };
    if (process.env.TEST_DATABASE_URL) await prisma.purchaseSession.update({ where: { id: fixture.record.id }, data: { state: 'UNKNOWN' } });
    const resume = await fetch(`${fixture.base}/watches/${fixture.watch.id}/resume`, { method: 'POST' });
    expect(resume.status).toBe(409);
    const acknowledged = await fetch(`${fixture.base}/watches/${fixture.watch.id}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledgeUnknown: true }),
    });
    expect(acknowledged.status).toBe(200);
  });

  it('keeps the payment form usable when the summary image cannot load', async () => {
    await dashboard.route(`**/artifacts/${fixture.screenshotId}`, (route) => route.fulfill({ status: 404, body: 'Missing screenshot' }));
    const pollPath = `**/watches/${fixture.watch.id}/purchase`;
    await dashboard.route(pollPath, (route) => route.fulfill({ json: {
      purchase: { ...fixture.record, state: 'WAITING_FOR_BLIK', summaryScreenshotArtifactId: fixture.screenshotId },
      serverTime: new Date().toISOString(), accountBusy: true,
    } }));
    try {
      await dashboard.reload();
      await dashboard.getByLabel('Kod BLIK', { exact: true }).waitFor();
      await dashboard.getByText('Podgląd podsumowania zakupu', { exact: true }).click();
      await dashboard.getByText('Nie udało się wczytać zrzutu podsumowania.', { exact: true }).waitFor();
      await dashboard.getByLabel('Kod BLIK', { exact: true }).fill('123456');
      expect(await dashboard.getByRole('button', { name: 'Zapłać 33,81 zł', exact: true }).isEnabled()).toBe(true);
    } finally {
      await dashboard.unroute(pollPath);
      await dashboard.unroute(`**/artifacts/${fixture.screenshotId}`);
    }
  });
});
