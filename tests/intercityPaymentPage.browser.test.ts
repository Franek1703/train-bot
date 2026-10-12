import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntercityPaymentPage, expiryFromText } from '../src/purchases/intercityPaymentPage.js';

// Local HTML only. No requests, credentials or payment codes reach Intercity or a bank.
const html = `<!doctype html><html lang="pl"><body>
  <p id="clock">Czas na zakup: 14:40</p>
  <p id="seat">Wagon 9, miejsce 17</p>
  <p>NIEDZIELA, 11 PAŹDZIERNIKA<br>IC 8112<br>15:27 Poznań Gł.<br>18:22 Warszawa Zach.<br>1 pasażer<br>2 klasa</p>
  <label>IMIĘ I NAZWISKO <input aria-label="Imię i nazwisko" value="Test Passenger"></label>
  <button id="proceed" onclick="document.querySelector('#payment').hidden=false;this.hidden=true">PŁATNOŚĆ</button>
  <section id="payment" hidden>
    <label><input type="checkbox" checked>Chcę podać dane do faktury</label>
    <label><input type="checkbox">Akceptuję Regulamin e-IC</label>
    <label><input type="checkbox">Akceptuję Regulamin Moje IC</label>
    <label><input type="radio" name="method">BLIK</label>
    <label><input type="checkbox" role="switch" checked>Darowizna na projekty środowiskowe</label>
    <input aria-label="Kod BLIK" placeholder="WPISZ KOD BLIK">
    <p>Do zapłaty<br>33,81 zł</p>
    <button id="pay" onclick="window.submissions=(window.submissions||0)+1;document.querySelector('#result').textContent='Potwierdź płatność w aplikacji bankowej'">ZAPŁAĆ</button>
    <button onclick="document.querySelector('#deferral').hidden=false">ZAPŁAĆ PÓŹNIEJ</button>
  </section>
  <p id="result"></p>
  <section id="deferral" role="dialog" hidden>
    <h2>Zapłać później</h2><p>Potwierdzenie płatności musi nastąpić w ciągu 15 minut od dokonania rezerwacji.</p>
    <button onclick="window.deferralConfirmed=true;document.querySelector('#deferral').hidden=true;document.querySelector('#result').textContent='Zamówienie oczekuje na płatność. Numer zamówienia: ORDER-1'">PRZEJDŹ DO OCZEKUJĄCYCH NA PŁATNOŚĆ</button>
    <button>ANULUJ</button>
  </section>
</body></html>`;

let server: Server;
let browser: Browser;
let page: Page;
let url: string;

beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch({ headless: true });
}, 30_000);
beforeEach(async () => { page = await browser.newPage(); await page.goto(url); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function adapter() {
  return new IntercityPaymentPage(page, { close: vi.fn(async () => {}) } as unknown as Browser, 'Wagon 9, miejsce 17', {
    trainNumber: 'IC 8112', departureTime: '15:27', travelClass: 2, passengers: 1,
    travelDate: new Date('2026-10-11T00:00:00Z'), origin: 'Poznań Główny', destination: 'Warszawa Zachodnia',
  });
}

describe('Intercity payment UI adapter', () => {
  it('clicks visible labels for hidden payment choices and shows the BLIK field after selection', async () => {
    await page.locator('body').evaluate(() => {
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]')) {
        input.style.display = 'none';
      }
      const code = document.querySelector<HTMLInputElement>('input[aria-label="Kod BLIK"]')!;
      code.id = 'blickCode'; code.type = 'number'; code.removeAttribute('aria-label'); code.placeholder = ' ';
      const label = document.createElement('label'); label.htmlFor = code.id; label.textContent = 'Wpisz kod blik';
      code.before(label);
      code.hidden = true;
      document.querySelector('input[type="radio"]')!.addEventListener('change', () => { code.hidden = false; });
    });
    await page.getByText('Do zapłaty', { exact: false }).evaluate((node) => {
      node.innerHTML = '<span>Do zapłaty<br>Obecna cena<br>33,81 zł</span><span>PTU 8%<br>2,50 zł</span>';
    });
    const payment = adapter();
    expect(await payment.prepare()).toMatchObject({ price: '33,81 zł', passengerName: 'Test Passenger' });
    expect(await page.getByLabel('BLIK', { exact: true }).isChecked()).toBe(true);
    expect(await page.getByLabel('Akceptuję Regulamin e-IC').isChecked()).toBe(true);
    expect(await page.getByLabel('Chcę podać dane do faktury').isChecked()).toBe(false);
    await payment.submit('012345');
    expect((await payment.observe()).outcome).toBe('pending');
  });
  it('uses passenger data from payment when summary has no name field, a train logo and unaccented watcher names', async () => {
    await page.locator('body').evaluate((node) => {
      const progress = document.createElement('nav');
      progress.innerHTML = '<button disabled>Płatność</button><button aria-disabled="true">Płatność</button>';
      node.prepend(progress);
    });
    await page.getByLabel('Imię i nazwisko').evaluate((node) => {
      document.querySelector('#payment')!.append(node.parentElement!);
    });
    await page.getByText(/NIEDZIELA, 11 PAŹDZIERNIKA/).evaluate((node) => {
      node.innerHTML = node.innerHTML.replace('IC 8112', '<svg aria-label="IC"></svg> 8112');
    });
    const payment = new IntercityPaymentPage(page, { close: vi.fn(async () => {}) } as unknown as Browser, 'Wagon 9, miejsce 17', {
      trainNumber: 'IC8112', departureTime: '15:27', travelClass: 2, passengers: 1,
      travelDate: new Date('2026-10-11'), origin: 'Poznan Gł', destination: 'Warszawa Zach',
    });
    expect(await payment.prepare()).toMatchObject({ passengerName: 'Test Passenger', price: '33,81 zł' });
    await payment.submit('012345');
    expect((await payment.observe()).outcome).toBe('pending');
  });
  it('opens payment, uses account data, accepts terms and disables invoice/donation', async () => {
    const details = await adapter().prepare();
    expect(details).toMatchObject({ passengerName: 'Test Passenger', price: '33,81 zł', intercityUrl: url });
    expect(await page.getByRole('checkbox', { name: /faktury/i }).isChecked()).toBe(false);
    expect(await page.getByRole('checkbox', { name: /Regulamin e-IC/i }).isChecked()).toBe(true);
    expect(await page.getByRole('checkbox', { name: /Regulamin Moje IC/i }).isChecked()).toBe(true);
    expect(await page.getByRole('radio', { name: 'BLIK' }).isChecked()).toBe(true);
    expect(await page.getByRole('switch').isChecked()).toBe(false);
    expect(details.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it.each(['PŁACĘ', 'PŁACĘ 33,81 zł', 'ZAPŁAĆ', 'ZAPŁAĆ 33,81 zł'])('waits for active %s, clicks once and waits for purchase evidence', async (label) => {
    const payment = adapter();
    await payment.prepare();
    await page.locator('#pay').evaluate((raw, name) => {
      const button = raw as HTMLButtonElement;
      button.textContent = name; button.disabled = true;
      document.querySelector('input[aria-label="Kod BLIK"]')!.addEventListener('input', () => {
        setTimeout(() => { button.disabled = false; }, 100);
      });
    }, label);
    await payment.submit('012345');
    expect(await page.getByLabel('Kod BLIK').inputValue()).toBe('012345');
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(1);
    await expect(payment.submit('012345')).rejects.toThrow('już wysłana');
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(1);
    expect((await payment.observe()).outcome).toBe('pending');
    await page.locator('#result').evaluate((node) => { node.textContent = 'Płatność została zrealizowana. Numer zamówienia: ORDER-1'; });
    expect(await payment.observe()).toMatchObject({ outcome: 'paid', orderNumber: 'ORDER-1' });
  });

  it('never clicks a disabled PŁACĘ or substitutes Zapłać później', async () => {
    const payment = adapter();
    await payment.prepare();
    await page.locator('#pay').evaluate((raw) => { const button = raw as HTMLButtonElement; button.textContent = 'PŁACĘ'; button.disabled = true; });
    await expect(payment.submit('012345')).rejects.toThrow('Kod nie został wysłany');
    expect(await page.evaluate(() => (window as unknown as { submissions?: number }).submissions ?? 0)).toBe(0);
    expect(await page.locator('#deferral').isVisible()).toBe(false);
    expect((await payment.observe()).outcome).toBe('pending');
  }, 10_000);

  it.each(['click', 'Enter'] as const)('intercepts PŁACĘ through remote %s without bypassing submission validation', async (mode) => {
    const payment = adapter(); await payment.prepare();
    await page.locator('#pay').evaluate((button) => { button.textContent = 'PŁACĘ'; });
    await page.locator('#pay').focus();
    const frame = await payment.remote.frame();
    const target = frame.targets.find((item) => item.label === 'PŁACĘ')!;
    const intercept = vi.fn(async () => {});
    await payment.remote.action(mode === 'click' ? { kind: 'click', frameId: frame.id, targetId: target.id }
      : { kind: 'key', frameId: frame.id, key: 'Enter' }, intercept);
    expect(intercept).toHaveBeenCalledOnce();
    expect(intercept).toHaveBeenCalledWith('submit');
    expect(await page.evaluate(() => (window as unknown as { submissions?: number }).submissions ?? 0)).toBe(0);
  });

  it('sanitizes an uncertain click and never automatically clicks again', async () => {
    const payment = adapter(); await payment.prepare();
    await page.locator('#pay').evaluate((button) => {
      button.textContent = 'PŁACĘ';
      // A visible, enabled button can still be blocked when Playwright dispatches.
      button.style.pointerEvents = 'none';
    });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(payment.submit('012345')).rejects.toThrow('Nie można potwierdzić wyniku kliknięcia');
      await expect(payment.submit('012345')).rejects.toThrow('już wysłana');
      const logs = JSON.stringify([...info.mock.calls, ...errors.mock.calls]);
      expect(logs).toContain('click result is uncertain');
      expect(logs).not.toContain('012345');
      expect(await page.evaluate(() => (window as unknown as { submissions?: number }).submissions ?? 0)).toBe(0);
    } finally { info.mockRestore(); errors.mockRestore(); }
  }, 10_000);

  it('recognises a rejected code and clears it before another attempt', async () => {
    const payment = adapter();
    await payment.prepare();
    await payment.submit('123456');
    await page.locator('#result').evaluate((node) => { node.textContent = 'Nieprawidłowy kod BLIK'; });
    expect((await payment.observe()).outcome).toBe('rejected');
    expect(await page.getByLabel('Kod BLIK').inputValue()).toBe('');
    expect((await payment.defer()).confirmed).toBe(true);
  });

  it('confirms deferral using an explicit result and refuses it during a submitted payment', async () => {
    const payment = adapter();
    await payment.prepare();
    expect(await payment.defer()).toMatchObject({ confirmed: true, orderNumber: 'ORDER-1' });
    expect(await page.evaluate(() => (window as unknown as { deferralConfirmed: boolean }).deferralConfirmed)).toBe(true);
    await page.goto(url);
    const pending = adapter();
    await pending.prepare();
    await pending.submit('123456');
    expect(await pending.defer()).toEqual({ confirmed: false });
  });

  it('does not confirm deferral merely because the modal closes and a pending heading appears', async () => {
    const payment = adapter();
    await payment.prepare();
    await page.getByRole('button', { name: 'PRZEJDŹ DO OCZEKUJĄCYCH NA PŁATNOŚĆ', includeHidden: true }).evaluate((node) => {
      node.setAttribute('onclick', "document.querySelector('#deferral').hidden=true;document.querySelector('#result').innerHTML='<h2>Oczekujące na płatność</h2><p>Brak zamówień</p>'");
    });
    expect((await payment.defer()).confirmed).toBe(false);
  });

  it('refuses a ticket without a guaranteed seat', async () => {
    await page.locator('#seat').evaluate((node) => { node.textContent = 'Brak gwarancji miejsca'; });
    await expect(adapter().prepare()).rejects.toThrow('miejsca');
    expect(await page.locator('#payment').isVisible()).toBe(false);
  });

  it('refuses a different watched train and does not submit a changed amount', async () => {
    const wrongTrain = new IntercityPaymentPage(page, browser, 'Wagon 9, miejsce 17', {
      trainNumber: 'IC 9999', departureTime: '15:27', travelClass: 2, passengers: 1,
    });
    await expect(wrongTrain.prepare()).rejects.toThrow('watcherem');
    const payment = adapter();
    await payment.prepare();
    await page.getByText('Do zapłaty', { exact: false }).evaluate((node) => { node.textContent = 'Do zapłaty 100,00 zł'; });
    await expect(payment.submit('123456')).rejects.toThrow('Dane płatności');
    expect(await page.getByLabel('Kod BLIK').inputValue()).toBe('');
  });

  it('refuses missing passenger data and unreadable clocks', async () => {
    await page.getByLabel('Imię i nazwisko').fill('');
    await expect(adapter().prepare()).rejects.toThrow('podróżnego');
    await page.goto(url);
    await page.locator('#clock').evaluate((node) => { node.textContent = 'Czas na zakup: —'; });
    await expect(adapter().prepare()).rejects.toThrow('licznika');
  });
});

describe('reservation clock parsing', () => {
  it('parses the labelled timer and rejects unrelated times or invalid minutes', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(expiryFromText('Odjazd 15:27\nCzas na zakup:\n11:44', now)).toEqual(new Date('2026-10-09T12:11:44Z'));
    expect(expiryFromText('Odjazd 15:27')).toBeUndefined();
    expect(expiryFromText('Czas na zakup: 19:00')).toBeUndefined();
    expect(expiryFromText('Czas na zakup: 12:99')).toBeUndefined();
  });
});
