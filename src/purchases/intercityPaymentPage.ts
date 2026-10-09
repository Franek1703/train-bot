import type { Browser, Locator, Page } from 'playwright';
import { extractSeatAssignment } from '../checker/parser.js';
import type { PaymentObservation, PurchasePage } from './types.js';
import { PaymentNotSubmittedError } from './types.js';

interface BookingExpectation {
  trainNumber: string | null; departureTime: string | null; travelClass: number; passengers: number;
  travelDate?: Date; origin?: string; destination?: string;
}

const months = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
function stationText(text: string): string {
  return text.toLocaleLowerCase('pl-PL').replace(/główn[yae]/g, 'gł').replace(/zachodni[ae]/g, 'zach')
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

  constructor(private readonly page: Page, private readonly browser: Browser, private readonly seatAssignment: string, private readonly expected?: BookingExpectation) {
    page.setDefaultTimeout(5_000);
    this.passenger = page.getByRole('textbox', { name: /imię i nazwisko/i })
      .or(page.getByLabel(/imię i nazwisko/i)).first();
    this.code = page.getByRole('textbox', { name: /kod blik/i })
      .or(page.getByPlaceholder(/wpisz kod blik/i)).or(page.getByLabel(/kod blik/i)).first();
  }

  private verifyBooking(text: string): void {
    if (extractSeatAssignment(text) !== this.seatAssignment || /brak gwarancji miejsca/i.test(text)) {
      throw new Error('Brak potwierdzonego miejsca w podsumowaniu.');
    }
    if (!this.expected) return;
    const { trainNumber, departureTime, travelClass, passengers } = this.expected;
    const trainPattern = trainNumber?.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
    if ((trainPattern && !new RegExp(`\\b${trainPattern}\\b`, 'i').test(text))
      || (departureTime && !text.includes(departureTime))
      || !new RegExp(`\\b${travelClass}\\s+klasa`, 'i').test(text)
      || !new RegExp(`\\b${passengers}\\s+pasażer`, 'i').test(text)
      || (this.expected.travelDate && !new RegExp(`\\b${this.expected.travelDate.getUTCDate()}\\s+${months[this.expected.travelDate.getUTCMonth()]}`, 'i').test(text))
      || (this.expected.origin && !stationText(text).includes(stationText(this.expected.origin)))
      || (this.expected.destination && !stationText(text).includes(stationText(this.expected.destination)))) {
      throw new Error('Pociąg, godzina, klasa lub liczba pasażerów nie zgadza się z watcherem.');
    }
  }

  private priceFromText(text: string): string | undefined {
    return text.match(/Do zapłaty\s*([\d\s]+[,.]\d{2})\s*zł/i)?.[1]?.replace(/\s/g, '');
  }

  private async body(): Promise<string> {
    return this.page.locator('body').innerText({ timeout: 5_000 });
  }

  async prepare() {
    const summary = await this.body();
    this.verifyBooking(summary);
    const passengerName = (await this.passenger.inputValue()).trim();
    if (!passengerName || /nazwisko podróżnego pokrywa się|zmień dane podróżnego/i.test(summary)) {
      throw new Error('Nieprawidłowe dane podróżnego na koncie Intercity.');
    }
    const pay = this.page.getByRole('button', { name: /^płatność$/i });
    await pay.waitFor({ state: 'visible', timeout: 20_000 });
    await pay.click();
    await this.code.or(this.page.getByRole('radio', { name: /^BLIK$/i })).first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    const paymentName = (await this.passenger.inputValue()).trim();
    if (paymentName !== passengerName) throw new Error('Dane podróżnego zmieniły się podczas przygotowania płatności.');
    await this.setCheckbox(/chcę podać dane do faktury/i, false, false);
    await this.setCheckbox(/akceptuję regulamin e-IC/i, true, true);
    await this.setCheckbox(/akceptuję regulamin Moje IC/i, true, false);
    const blik = this.page.getByRole('radio', { name: /^BLIK$/i });
    await blik.check();
    const donation = this.page.getByRole('switch', { name: /darowizna/i })
      .or(this.page.getByRole('checkbox', { name: /darowizna/i })).first();
    if (await donation.count()) await donation.setChecked(false);
    const text = await this.body();
    this.verifyBooking(text);
    const price = this.priceFromText(text);
    if (!price || Number(price.replace(',', '.')) <= 0) throw new Error('Brak kwoty płatności BLIK.');
    await this.code.waitFor({ state: 'visible' });
    this.prepared = { passengerName, price };
    return { passengerName, price: `${price} zł`, intercityUrl: pageLink(this.page), expiresAt: await readReservationExpiry(this.page) };
  }

  private async setCheckbox(name: RegExp, checked: boolean, required: boolean): Promise<void> {
    const checkbox = this.page.getByRole('checkbox', { name }).first();
    if (await checkbox.count()) await checkbox.setChecked(checked);
    else if (required) throw new Error('Nie znaleziono wymaganego regulaminu.');
  }

  async submit(code: string): Promise<void> {
    try {
      const text = await this.body();
      this.verifyBooking(text);
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

  async defer() {
    if (this.submitted) return { confirmed: false };
    const button = this.page.getByRole('button', { name: /^zapłać później$/i });
    if (!await button.isVisible().catch(() => false) || !await button.isEnabled()) return { confirmed: false };
    await button.click();
    // Confirm using an explicit result; disappearing buttons alone prove nothing.
    const confirmation = this.page.getByText(/(?:zamówienie zostało zapisane|płatność została odroczona|zamówienie oczekuje na płatność|bilet oczekuje na (?:opłacenie|płatność))/i).first();
    await confirmation.waitFor({ state: 'visible', timeout: 15_000 });
    const text = await this.body();
    return {
      confirmed: true, intercityUrl: pageLink(this.page),
      orderNumber: text.match(/(?:numer zamówienia|nr zamówienia)\s*:?\s*([\w/-]+)/i)?.[1],
    };
  }

  async close(): Promise<void> { await this.browser.close(); }
}
