import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBuyButtonLoadingMore } from '../src/checker/intercityChecker.js';

// Local HTML mimicking Intercity's result list: a few cards, PÓŹNIEJ / WCZEŚNIEJ load more.
// Button names follow the real page: "Kup bilet na połączenie  HH:mm <from> <to>".
const html = `<!doctype html><html lang="pl"><body>
  <button id="earlier">WCZEŚNIEJ</button>
  <div id="list"></div>
  <button id="later">PÓŹNIEJ</button>
<script>
  const card = (t) => '<article><p>' + t + '</p><button aria-label="Kup bilet na połączenie  ' + t + ' Warszawa Zach. Poznań Gł.">KUP BILET</button></article>';
  const list = document.getElementById('list');
  list.innerHTML = ['15:37', '16:05', '17:05'].map(card).join('');
  let laterPages = [['17:37', '18:05'], ['19:37']];
  let earlierPages = [['06:05', '07:05']];
  const later = document.getElementById('later'); const earlier = document.getElementById('earlier');
  later.onclick = () => { const next = laterPages.shift(); if (!next) return; setTimeout(() => { list.insertAdjacentHTML('beforeend', next.map(card).join('')); if (!laterPages.length) later.hidden = true; }, 100); };
  earlier.onclick = () => { const next = earlierPages.shift(); if (!next) return; setTimeout(() => { list.insertAdjacentHTML('afterbegin', next.map(card).join('')); if (!earlierPages.length) earlier.hidden = true; }, 100); };
</script></body></html>`;

let server: Server;
let browser: Browser;
let page: Page;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
beforeEach(async () => { page = await browser.newPage(); await page.goto(`${baseUrl}/wyszukiwanie?dwyj=2026-11-06&time=15%3A36`); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

const find = (departureTime: string) => findBuyButtonLoadingMore(
  page, { id: 'w1', trainNumber: 'IC 1760', departureTime }, new RegExp(`kup bilet.*${departureTime.replace(':', '\\:')}`, 'i'),
);

describe('finding a train outside the first page of results', () => {
  it('uses a visible train without loading more', async () => {
    expect(await find('16:05')).toBeDefined();
    expect(await page.getByRole('button', { name: /kup bilet/i }).count()).toBe(3);
  });

  it('presses PÓŹNIEJ until a later train appears', async () => {
    const button = await find('19:37');
    expect(button).toBeDefined();
    expect(await button!.getAttribute('aria-label')).toContain('19:37');
  });

  it('presses WCZEŚNIEJ for a train earlier than the search time', async () => {
    const button = await find('06:05');
    expect(await button!.getAttribute('aria-label')).toContain('06:05');
  });

  it('gives up cleanly when the train is not in the list', async () => {
    expect(await find('23:50')).toBeUndefined();
    expect(await page.getByRole('button', { name: /kup bilet/i }).count()).toBe(6);
  });
});
