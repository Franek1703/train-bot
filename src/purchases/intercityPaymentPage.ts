import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { env } from '../config/env.js';
import { extractSeatAssignment } from '../checker/parser.js';
import type { PaymentObservation, PurchasePage } from './types.js';
import { PaymentNotSubmittedError, PurchasePreparationError } from './types.js';
import { IntercityRemotePage } from './remotePage.js';
import { paymentButtonName } from './paymentButtons.js';

interface BookingExpectation {
  trainNumber: string | null; departureTime: string | null; travelClass: number; passengers: number;
  travelDate?: Date; origin?: string; destination?: string;
}

// On "Moje bilety" an unpaid transaction is paid with a "BLIK" button; older layouts used "Zapłać".
const deferredPayName = /^(?:blik|zapłać(?:\s+teraz)?(?:\s+[\d\s]+[,.]\d{2}\s*zł)?)$/i;
const orderNumberPattern = /(?:numer zamówienia|nr zamówienia|numer transakcji)\s*:?\s*([\w/-]+)/i;

const months = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
// Intercity prints single-digit days zero-padded ("06 listopada"), so the leading zero must be optional.
export function mentionsTravelDate(text: string, date: Date): boolean {
  return new RegExp(`\\b0?${date.getUTCDate()}\\s+${months[date.getUTCMonth()]}`, 'i').test(text);
}

function stationText(text: string): string {
  return text.toLocaleLowerCase('pl-PL').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l')
    .replace(/glown[yae]/g, 'gl').replace(/zachodni[ae]/g, 'zach')
    .replace(/wschodni[ae]/g, 'wsch').replace(/centralna/g, 'centr').replace(/[.,-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function expiryFromText(text: string, now = new Date()): Date | undefined {
  const match = text.match(/Czas\s+na\s+zakup\s*:?\s*(\d{1,2}):([0-5]\d)/i);
  if (!match) return undefined;
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds > 15 * 60) return undefined;
  return new Date(now.getTime() + seconds * 1_000);
}

export async function readReservationExpiry(page: Page): Promise<Date> {
  const text = await page.locator('body').innerText({ timeout: 5_000 });
  const expiresAt = expiryFromText(text);
  if (!expiresAt) throw new Error('Nie można odczytać licznika rezerwacji Intercity.');
  return expiresAt;
}

// Only page locations are stored; query parameters can contain payment credentials.
function pageLink(page: Page): string {
  const url = new URL(page.url());
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class IntercityPaymentPage implements PurchasePage {
  private submitted = false;
  private readonly passenger: Locator;
  private readonly code: Locator;
  private prepared?: { passengerName: string; price: string };
  // Set when BLIK is paid from the "Moje bilety" order card instead of the checkout form.
  private orderCardPayment = false;
  readonly remote: IntercityRemotePage;

  constructor(private readonly page: Page, private readonly browser: Browser, private readonly seatAssignment: string, private readonly expected?: BookingExpectation) {
    page.setDefaultTimeout(5_000);
    this.remote = new IntercityRemotePage(page);
    this.passenger = page.getByRole('textbox', { name: /imię i nazwisko/i })
      .or(page.getByLabel(/imię i nazwisko/i)).first();
    this.code = page.getByRole('textbox', { name: /kod blik/i })
      .or(page.getByPlaceholder(/wpisz kod blik/i)).or(page.getByLabel(/kod blik/i)).first();
  }

  private verifyBooking(text: string): void {
    if (extractSeatAssignment(text) !== this.seatAssignment || /brak gwarancji miejsca/i.test(text)) {
      throw new PurchasePreparationError('Brak potwierdzonego miejsca w podsumowaniu.');
    }
    if (!this.expected) return;
    const { trainNumber, departureTime, travelClass, passengers } = this.expected;
    // Intercity renders the category as a logo, which may have no innerText.
    const trainParts = trainNumber?.trim().match(/^([a-z]+)\s*(\d+)$/i);
    const trainPattern = trainParts ? `(?:${trainParts[1]}\\s*)?${trainParts[2]}`
      : trainNumber?.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    const checks: Array<[string, boolean]> = [
      ['Numer pociągu', !trainPattern || new RegExp(`\\b${trainPattern}\\b`, 'i').test(text)],
      ['Godzina odjazdu', !departureTime || text.includes(departureTime)],
      ['Klasa', new RegExp(`\\b${travelClass}\\s+klasa`, 'i').test(text)],
      ['Liczba pasażerów', new RegExp(`\\b${passengers}\\s+pasażer`, 'i').test(text)],
      ['Data podróży', !this.expected.travelDate || mentionsTravelDate(text, this.expected.travelDate)],
      ['Stacja początkowa', !this.expected.origin || stationText(text).includes(stationText(this.expected.origin))],
      ['Stacja docelowa', !this.expected.destination || stationText(text).includes(stationText(this.expected.destination))],
    ];
    for (const [field, matches] of checks) {
      if (!matches) throw new PurchasePreparationError(`${field} w podsumowaniu nie zgadza się z watcherem.`);
    }
  }

  private priceFromText(text: string): string | undefined {
    // Intercity includes "Obecna cena" in innerText between the total heading and amount.
    return text.match(/Do zapłaty\s*(?:Obecna cena\s*)?(?:PTU\s+\d+(?:[,.]\d+)?%\s*)?([\d\s]+[,.]\d{2})\s*zł/i)?.[1]?.replace(/\s/g, '');
  }

  private async body(): Promise<string> {
    return this.page.locator('body').innerText({ timeout: 5_000 });
  }

  async prepare() {
    const summary = await this.body();
    this.verifyBooking(summary);
    const summaryPassenger = await this.passenger.isVisible().catch(() => false)
      ? (await this.passenger.inputValue()).trim() : undefined;
    // The progress bar also contains a disabled button named "Płatność".
    const pay = this.page.getByRole('button', { name: /^płatność$/i })
      .and(this.page.locator('button:not([disabled]):not([aria-disabled="true"])'));
    await pay.waitFor({ state: 'visible', timeout: 20_000 });
    await pay.click();
    return this.preparePaymentForm(summaryPassenger);
  }

  private async preparePaymentForm(summaryPassenger?: string) {
    await this.passenger.waitFor({ state: 'visible', timeout: 20_000 });
    const paymentName = (await this.passenger.inputValue()).trim();
    if (!paymentName || /nazwisko podróżnego pokrywa się|zmień dane podróżnego/i.test(await this.body())) {
      throw new Error('Nieprawidłowe dane podróżnego na koncie Intercity.');
    }
    if (summaryPassenger !== undefined && paymentName !== summaryPassenger) {
      throw new Error('Dane podróżnego zmieniły się podczas przygotowania płatności.');
    }
    const passengerName = paymentName;
    await this.setCheckbox(/chcę podać dane do faktury/i, false, false);
    await this.setCheckbox(/akceptuję regulamin e-IC/i, true, true);
    await this.setCheckbox(/akceptuję regulamin Moje IC/i, true, false);
    const blik = this.page.getByLabel(/^BLIK$/i).and(this.page.locator('input[type="radio"]')).first();
    await this.setChoice(blik, /^BLIK$/i, true);
    const donation = this.page.getByRole('switch', { name: /darowizna/i })
      .or(this.page.getByLabel(/darowizna/i).and(this.page.locator('input[type="checkbox"]'))).first();
    if (await donation.count()) await this.setChoice(donation, /darowizna/i, false);
    const text = await this.body();
    this.verifyBooking(text);
    const price = this.priceFromText(text);
    if (!price || Number(price.replace(',', '.')) <= 0) throw new PurchasePreparationError('Brak kwoty płatności BLIK.');
    await this.code.waitFor({ state: 'visible' });
    if (this.prepared && (this.prepared.passengerName !== passengerName || this.prepared.price !== price)) {
      throw new PurchasePreparationError('Dane zamówienia zmieniły się po odroczeniu płatności.');
    }
    this.prepared = { passengerName, price };
    return { passengerName, price: `${price} zł`, intercityUrl: pageLink(this.page), expiresAt: await readReservationExpiry(this.page) };
  }

  private async setCheckbox(name: RegExp, checked: boolean, required: boolean): Promise<void> {
    const checkbox = this.page.getByLabel(name).and(this.page.locator('input[type="checkbox"]')).first();
    if (await checkbox.count()) await this.setChoice(checkbox, name, checked);
    else if (required) throw new PurchasePreparationError('Nie znaleziono wymaganego regulaminu.');
  }

  private async setChoice(input: Locator, label: RegExp, checked: boolean): Promise<void> {
    if (await input.isChecked() === checked) return;
    if (await input.isVisible()) await input.setChecked(checked);
    else await this.page.locator('label').filter({ hasText: label }).first().click();
    if (await input.isChecked() !== checked) {
      throw new PurchasePreparationError('Intercity nie potwierdziło wyboru metody płatności lub regulaminu.');
    }
  }

  async submit(code: string): Promise<void> {
    if (this.submitted) throw new Error('Płatność została już wysłana.');
    const pay = this.page.getByRole('button', { name: paymentButtonName })
      .and(this.page.locator('button:not([disabled]):not([aria-disabled="true"])')).filter({ visible: true });
    try {
      const text = await this.body();
      if (this.orderCardPayment) {
        if (!this.prepared || !this.matchesDeferredOrder(text) || !text.replace(/\s/g, '').includes(this.prepared.price)) {
          throw new Error('Changed payment details');
        }
      } else {
        this.verifyBooking(text);
        const method = this.page.getByLabel(/^BLIK$/i).and(this.page.locator('input[type="radio"]')).first();
        if (!await method.isChecked()) throw new Error('Changed payment method');
        if (!this.prepared || this.priceFromText(text) !== this.prepared.price
          || (await this.passenger.inputValue()).trim() !== this.prepared.passengerName) {
          throw new Error('Changed payment details');
        }
      }
      await this.code.fill(code);
      await this.code.blur();
      console.log(JSON.stringify({ level: 'info', message: 'BLIK code entered on Intercity payment page' }));
      await pay.waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      console.error(JSON.stringify({ level: 'error', message: 'Intercity payment was not submitted; checkout or active payment button unavailable' }));
      throw new PaymentNotSubmittedError('Dane płatności, pole BLIK lub aktywny przycisk Płacę są niedostępne. Kod nie został wysłany do płatności.');
    } finally {
      code = '';
    }
    this.submitted = true;
    // Never log Playwright errors from this method: they may include the input value.
    console.log(JSON.stringify({ level: 'info', message: 'Clicking Intercity payment button' }));
    try {
      await pay.click({ timeout: 5_000 });
      console.log(JSON.stringify({ level: 'info', message: 'Intercity payment button click completed' }));
    } catch {
      console.error(JSON.stringify({ level: 'error', message: 'Intercity payment button click result is uncertain' }));
      throw new Error('Nie można potwierdzić wyniku kliknięcia przycisku płatności Intercity.');
    }
  }

  async observe(): Promise<PaymentObservation> {
    const text = await this.body();
    const expiresAt = expiryFromText(text);
    const orderNumber = text.match(orderNumberPattern)?.[1];
    // A payment request, redirect, or bank authorisation prompt is not a purchased ticket.
    if (this.submitted && /(?:płatność zakończona pomyślnie|płatność została zrealizowana|bilet został zakupiony|zakup zakończony pomyślnie|dziękujemy za zakup)/i.test(text)) {
      return { outcome: 'paid', orderNumber, intercityUrl: pageLink(this.page) };
    }
    // Intercity may land on "Moje bilety": a ticket number on this train's card proves the purchase.
    if (this.submitted && /numer biletu/i.test(text)) {
      const ticketNumber = await this.purchasedTicket();
      if (ticketNumber) return { outcome: 'paid', orderNumber: ticketNumber, intercityUrl: pageLink(this.page) };
    }
    if (/czas (?:na zakup|rezerwacji).*?(?:minął|upłynął)|sesja (?:wygasła|zakończona)|rezerwacja wygasła/i.test(text)) {
      return { outcome: 'expired' };
    }
    const rejected = /(?:płatność (?:została )?odrzucona|transakcja (?:została )?odrzucona|nieprawidłowy kod BLIK|kod BLIK (?:jest )?(?:nieprawidłowy|wygasł)|płatność nie powiodła się)/i.test(text);
    if (this.submitted && rejected && await this.code.isVisible().catch(() => false)) {
      this.submitted = false;
      await this.code.fill('');
      return { outcome: 'rejected', expiresAt };
    }
    return { outcome: 'pending', expiresAt };
  }

  async readCode(): Promise<string> { return this.code.inputValue(); }

  private matchesDeferredOrder(text: string, orderNumber?: string | null): boolean {
    if (orderNumber) return text.includes(orderNumber);
    if (!this.expected?.trainNumber || !this.expected.departureTime) return false;
    const digits = this.expected.trainNumber.replace(/\D/g, '');
    const date = this.expected.travelDate;
    const dates = date ? [
      `${date.getUTCDate()} ${months[date.getUTCMonth()]}`,
      `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]}`,
      date.toISOString().slice(0, 10),
      `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`,
    ] : [];
    return new RegExp(`\\b${digits}\\b`).test(text) && text.includes(this.expected.departureTime)
      && (!date || dates.some((value) => text.toLocaleLowerCase('pl-PL').includes(value)))
      && (!this.expected.origin || stationText(text).includes(stationText(this.expected.origin)))
      && (!this.expected.destination || stationText(text).includes(stationText(this.expected.destination)));
  }

  // The ticket card for the expected train on "Moje bilety" (not an unpaid transaction).
  private async purchasedTicket(): Promise<string | undefined> {
    const cards = this.page.locator('div, li, article, section')
      .filter({ hasText: /numer biletu/i }).filter({ hasNotText: /nieopłacon/i });
    let best: string | undefined;
    const count = Math.min(await cards.count(), 150);
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).innerText({ timeout: 2_000 }).catch(() => '');
      if (!this.matchesDeferredOrder(text)) continue;
      if (!best || text.length < best.length) best = text;
    }
    // Several tickets in the smallest matching container means it is a list, not this train's card.
    if (!best || (best.match(/numer biletu/gi) ?? []).length !== 1) return undefined;
    return best.match(/numer biletu\s*:?\s*([A-Z0-9/-]+)/i)?.[1];
  }

  async diagnose(label: string): Promise<void> { await this.saveDiagnostic(label); }

  private async deferredOrder(orderNumber?: string | null): Promise<{ container: Locator; button: Locator } | undefined> {
    const buttons = this.page.getByRole('button', { name: deferredPayName })
      .or(this.page.getByRole('link', { name: deferredPayName }));
    const matches: Array<{ container: Locator; button: Locator }> = [];
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i);
      if (!await button.isVisible()) continue;
      let container = button;
      for (let depth = 0; depth < 12; depth++) {
        container = container.locator('xpath=..');
        const text = await container.innerText().catch(() => '');
        if (this.matchesDeferredOrder(text, orderNumber)) {
          if (await container.getByLabel(/kod blik/i).or(container.getByPlaceholder(/wpisz kod blik/i)).filter({ visible: true }).count()) break;
          // A page containing multiple orders is not an identifiable order card.
          const payButtons = container.getByRole('button', { name: deferredPayName })
            .or(container.getByRole('link', { name: deferredPayName }));
          if (await payButtons.count() === 1) matches.push({ container, button });
          break;
        }
      }
    }
    if (matches.length > 1) throw new PurchasePreparationError('Nie można jednoznacznie wskazać odroczonego zamówienia.');
    return matches[0];
  }

  async resumeDeferred(orderNumber: string | null): Promise<{ expiresAt?: Date }> {
    this.remote.invalidate();
    if (await this.passenger.isVisible().catch(() => false)) {
      return { expiresAt: (await this.preparePaymentForm()).expiresAt };
    }
    const order = await this.deferredOrder(orderNumber);
    if (!order) throw new PurchasePreparationError('Nie znaleziono właściwego zamówienia oczekującego na płatność.');
    const orderText = await order.container.innerText().catch(() => '');
    await order.button.click();
    await this.passenger.or(this.page.getByRole('button', { name: /^płatność$/i })
      .and(this.page.locator('button:not([disabled]):not([aria-disabled="true"])'))).or(this.code)
      .filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
    await this.saveDiagnostic('resume-deferred');
    if (await this.passenger.isVisible().catch(() => false)) return { expiresAt: (await this.preparePaymentForm()).expiresAt };
    if (!await this.code.isVisible().catch(() => false)) return { expiresAt: (await this.prepare()).expiresAt };
    // BLIK opened straight from the "Moje bilety" order card: no seat summary on this page,
    // so check the identified order and amount instead.
    const price = this.prepared?.price;
    if (!price || !orderText.replace(/\s/g, '').includes(price)) {
      throw new PurchasePreparationError('Kwota odroczonego zamówienia nie zgadza się z przygotowanym zakupem.');
    }
    this.orderCardPayment = true;
    return { expiresAt: expiryFromText(orderText) };
  }

  async canPay(): Promise<boolean> {
    if (this.submitted) return false;
    // Close a leftover "Zapłać później" modal so the code field is reachable.
    if (await this.deferProceedButton().isVisible().catch(() => false)) await this.page.keyboard.press('Escape').catch(() => {});
    return this.code.isVisible().catch(() => false);
  }

  private deferProceedButton(): Locator {
    const name = /przejdź do oczekujących/i;
    return this.page.getByRole('button', { name }).or(this.page.getByRole('link', { name })).filter({ visible: true }).first();
  }

  private async saveDiagnostic(label: string): Promise<void> {
    // Watch id is available at runtime: the checker passes the full watch as the expectation.
    const watchId = (this.expected as { id?: string } | undefined)?.id ?? 'purchase';
    try {
      // Diagnostics must never interrupt a purchase.
      const dir = path.join(env.SCREENSHOTS_DIR, watchId);
      const file = path.join(dir, `${label}-${Date.now()}.png`);
      await mkdir(dir, { recursive: true });
      await this.page.screenshot({ path: file, fullPage: true });
      const body = (await this.body().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500);
      console.log(JSON.stringify({ level: 'info', message: 'Deferral diagnostic saved', label, screenshotPath: file, url: pageLink(this.page), bodyPreview: body }));
    } catch {
      console.error(JSON.stringify({ level: 'error', message: 'Could not save deferral diagnostic', label }));
    }
  }

  // Resumable: a retry continues from the modal or from the pending-orders page.
  async defer() {
    if (this.submitted) return { confirmed: false };
    this.remote.invalidate();
    try {
      return await this.deferSteps();
    } catch (error) {
      await this.saveDiagnostic('defer-error');
      throw error;
    }
  }

  private async deferSteps() {
    const proceed = this.deferProceedButton();
    const pendingHeading = this.page.getByRole('heading', { name: /oczekując\w* na płatność/i }).filter({ visible: true }).first();
    // Confirm using an explicit result; disappearing buttons alone prove nothing.
    const confirmation = this.page.getByText(/(?:zamówienie zostało zapisane|płatność została odroczona|zamówienie oczekuje na płatność|bilet oczekuje na (?:opłacenie|płatność))/i).filter({ visible: true }).first();
    // Intercity now lands on "Moje bilety", listing the order as "Transakcja nieopłacona".
    // That text alone may belong to another order, so it only ends the wait; the order card confirms.
    const pendingList = this.page.getByText(/transakcja nieopłacona/i).filter({ visible: true }).first();
    const pendingPage = pendingHeading.or(pendingList);
    const alreadyPending = await pendingPage.or(confirmation).first().isVisible().catch(() => false);
    if (!alreadyPending) {
      if (!await proceed.isVisible().catch(() => false)) {
        const later = /^zapłać później$/i;
        const button = this.page.getByRole('button', { name: later }).or(this.page.getByRole('link', { name: later }))
          .filter({ visible: true }).first();
        if (!await button.isVisible().catch(() => false) || !await button.isEnabled().catch(() => false)) {
          await this.saveDiagnostic('defer-no-button');
          return { confirmed: false };
        }
        await button.click();
        await proceed.or(pendingPage).or(confirmation).first().waitFor({ state: 'visible', timeout: 30_000 });
      }
      if (await proceed.isVisible().catch(() => false)) {
        await proceed.click();
        await proceed.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
      }
      await confirmation.or(pendingPage).first().waitFor({ state: 'visible', timeout: 30_000 });
      // Pending orders load after the heading.
      await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
    const order = await this.deferredOrder();
    if (!order && !await confirmation.isVisible()) {
      await this.saveDiagnostic('defer-unconfirmed');
      return { confirmed: false };
    }
    const orderText = order ? await order.container.innerText() : '';
    const text = await this.body();
    return {
      confirmed: true, intercityUrl: pageLink(this.page),
      orderNumber: (orderText || text).match(orderNumberPattern)?.[1],
      expiresAt: order ? expiryFromText(orderText) : undefined,
    };
  }

  async close(): Promise<void> { await this.browser.close(); }
}
