import type { Browser, Locator, Page } from 'playwright';
import { extractSeatAssignment } from '../checker/parser.js';
import type { PaymentObservation, PurchasePage } from './types.js';
import { PaymentNotSubmittedError, PurchasePreparationError } from './types.js';
import { IntercityRemotePage } from './remotePage.js';

interface BookingExpectation {
  trainNumber: string | null; departureTime: string | null; travelClass: number; passengers: number;
  travelDate?: Date; origin?: string; destination?: string;
}

const months = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
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
      ['Data podróży', !this.expected.travelDate || new RegExp(`\\b${this.expected.travelDate.getUTCDate()}\\s+${months[this.expected.travelDate.getUTCMonth()]}`, 'i').test(text)],
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
    try {
      const text = await this.body();
      this.verifyBooking(text);
      const method = this.page.getByLabel(/^BLIK$/i).and(this.page.locator('input[type="radio"]')).first();
      if (!await method.isChecked()) throw new Error('Changed payment method');
      if (!this.prepared || this.priceFromText(text) !== this.prepared.price
        || (await this.passenger.inputValue()).trim() !== this.prepared.passengerName) {
        throw new Error('Changed payment details');
      }
      await this.code.fill(code);
    } catch {
      throw new PaymentNotSubmittedError('Dane płatności lub pole BLIK są niedostępne. Kod nie został wysłany do płatności.');
    }
    this.submitted = true;
    // Never log Playwright errors from this method: they may include the input value.
    try {
      await this.page.getByRole('button', { name: /^zapłać(?:\s+[\d\s,.]+\s*zł)?$/i }).click();
    } finally { code = ''; }
  }

  async observe(): Promise<PaymentObservation> {
    const text = await this.body();
    const expiresAt = expiryFromText(text);
    const orderNumber = text.match(/(?:numer zamówienia|nr zamówienia)\s*:?\s*([\w/-]+)/i)?.[1];
    // A payment request, redirect, or bank authorisation prompt is not a purchased ticket.
    if (this.submitted && /(?:płatność zakończona pomyślnie|płatność została zrealizowana|bilet został zakupiony|zakup zakończony pomyślnie)/i.test(text)) {
      return { outcome: 'paid', orderNumber, intercityUrl: pageLink(this.page) };
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
      date.toISOString().slice(0, 10),
      `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`,
    ] : [];
    return new RegExp(`\\b${digits}\\b`).test(text) && text.includes(this.expected.departureTime)
      && (!date || dates.some((value) => text.toLocaleLowerCase('pl-PL').includes(value)))
      && (!this.expected.origin || stationText(text).includes(stationText(this.expected.origin)))
      && (!this.expected.destination || stationText(text).includes(stationText(this.expected.destination)));
  }

  private async deferredOrder(orderNumber?: string | null): Promise<{ container: Locator; button: Locator } | undefined> {
    const buttons = this.page.getByRole('button', { name: /^zapłać(?:\s+teraz)?$/i })
      .or(this.page.getByRole('link', { name: /^zapłać(?:\s+teraz)?$/i }));
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
          const payButtons = container.getByRole('button', { name: /^zapłać(?:\s+teraz)?$/i })
            .or(container.getByRole('link', { name: /^zapłać(?:\s+teraz)?$/i }));
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
    await order.button.click();
    await this.passenger.or(this.page.getByRole('button', { name: /^płatność$/i })
      .and(this.page.locator('button:not([disabled]):not([aria-disabled="true"])'))).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    const details = await this.passenger.isVisible().catch(() => false) ? await this.preparePaymentForm() : await this.prepare();
    return { expiresAt: details.expiresAt };
  }

  async defer() {
    if (this.submitted) return { confirmed: false };
    this.remote.invalidate();
    const proceed = this.page.getByRole('button', { name: /^przejdź do oczekujących na płatność$/i });
    if (!await proceed.isVisible().catch(() => false)) {
      const button = this.page.getByRole('button', { name: /^zapłać później$/i });
      if (!await button.isVisible().catch(() => false) || !await button.isEnabled()) return { confirmed: false };
      await button.click();
    }
    await proceed.waitFor({ state: 'visible', timeout: 15_000 });
    await proceed.click();
    await proceed.waitFor({ state: 'hidden', timeout: 15_000 });
    // Confirm using an explicit result; disappearing buttons alone prove nothing.
    const confirmation = this.page.getByText(/(?:zamówienie zostało zapisane|płatność została odroczona|zamówienie oczekuje na płatność|bilet oczekuje na (?:opłacenie|płatność))/i).first();
    await confirmation.or(this.page.getByRole('heading', { name: /^oczekujące na płatność$/i })).first().waitFor({ state: 'visible', timeout: 15_000 });
    const order = await this.deferredOrder();
    if (!order && !await confirmation.isVisible()) return { confirmed: false };
    const orderText = order ? await order.container.innerText() : '';
    const text = await this.body();
    return {
      confirmed: true, intercityUrl: pageLink(this.page),
      orderNumber: (orderText || text).match(/(?:numer zamówienia|nr zamówienia)\s*:?\s*([\w/-]+)/i)?.[1],
      expiresAt: order ? expiryFromText(orderText) : undefined,
    };
  }

  async close(): Promise<void> { await this.browser.close(); }
}
