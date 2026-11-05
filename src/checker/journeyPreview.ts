import type { Browser, Page, Response } from 'playwright';
import { env } from '../config/env.js';
import { launchIntercityBrowser } from './browser.js';
import {
  JourneyUrlError,
  parseJourneyUrl,
  parseTicketSummary,
  pickConnection,
  toDirectConnections,
  type DirectConnection,
  type RawConnection,
} from './journeyUrl.js';

export interface PreviewPrice {
  travelClass: number;
  price: number; // PLN
  note?: string;
}

export interface PreviewConnection extends DirectConnection {
  prices: PreviewPrice[];
}

export interface JourneyPreview {
  searchUrl: string;
  origin: string;
  destination: string;
  date: string;
  passengers?: number;
  ticketLabel?: string;
  confidence: 'exact' | 'guess';
  selected: PreviewConnection;
  alternatives: PreviewConnection[];
}

interface Station { kod: number; nazwa: string; kodEVA?: number }
interface PriceEntry { idPolaczenia: number; ceny: Array<{ klasa: number; cena: number; komunikatTekst?: string }> }

const PREVIEW_TIMEOUT_MS = 45_000;
let previewRunning = false;

export async function previewJourney(input: string): Promise<JourneyPreview> {
  const parsed = parseJourneyUrl(input);
  if (new Date(`${parsed.date}T23:59:59`).getTime() < Date.now()) {
    throw new JourneyUrlError('Data podróży jest już w przeszłości.');
  }
  if (previewRunning) throw new JourneyUrlError('Trwa już inny podgląd podróży. Spróbuj za chwilę.', 409);
  previewRunning = true;

  const startedAt = Date.now();
  let browser: Browser | undefined;
  try {
    browser = await launchIntercityBrowser();
    const context = await browser.newContext({ locale: 'pl-PL', timezoneId: env.TIMEZONE });
    const page = await context.newPage();
    const collected = collectResponses(page);

    await page.goto(parsed.searchUrl, { waitUntil: 'commit', timeout: PREVIEW_TIMEOUT_MS }).catch(() => undefined);
    const connections = await collected.connections(PREVIEW_TIMEOUT_MS - (Date.now() - startedAt)).catch(async () => {
      const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
      const maintenance = /przerwa technologiczna/i.test(body) && /23:45/.test(body) && new Date().getHours() < 1;
      throw new JourneyUrlError(
        maintenance
          ? 'Trwa przerwa technologiczna Intercity (23:45–00:30). Spróbuj później.'
          : 'Nie udało się pobrać listy połączeń z Intercity. Spróbuj ponownie lub użyj trybu ręcznego.',
        502,
      );
    });

    const direct = toDirectConnections(connections);
    if (!direct.length) {
      throw new JourneyUrlError('Brak bezpośrednich połączeń dla tych parametrów (przesiadki nie są obsługiwane).', 404);
    }

    // Station names, ticket summary and prices are best-effort companions of the connection list.
    await page.waitForTimeout(1_500);
    const stations = collected.stations();
    const origin = stationName(stations, parsed.originCode);
    const destination = stationName(stations, parsed.destinationCode);
    if (!origin || !destination) {
      throw new JourneyUrlError('Nie udało się odczytać nazw stacji z Intercity.', 502);
    }
    const body = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    const { passengers, ticketLabel } = parseTicketSummary(body);
    const prices = collected.prices();
    const withPrices = (connection: DirectConnection): PreviewConnection => ({
      ...connection,
      prices: (prices.get(connection.connectionId) ?? []).map((entry) => ({ travelClass: entry.klasa, price: entry.cena / 100, note: entry.komunikatTekst?.trim() || undefined })),
    });

    const picked = pickConnection(direct, parsed.time);
    const alternatives = direct.filter((connection) => connection.date === parsed.date).map(withPrices);
    console.log(JSON.stringify({ level: 'info', message: 'Journey preview finished', confidence: picked.confidence, connections: direct.length, durationMs: Date.now() - startedAt }));

    return {
      searchUrl: parsed.searchUrl,
      origin,
      destination,
      date: parsed.date,
      passengers,
      ticketLabel,
      confidence: picked.confidence === 'exact' ? 'exact' : 'guess',
      selected: withPrices(picked.connection!),
      alternatives,
    };
  } finally {
    previewRunning = false;
    await browser?.close().catch(() => undefined);
  }
}

function stationName(stations: Station[], evaCode: string): string | undefined {
  return stations.find((station) => String(station.kodEVA) === evaCode)?.nazwa?.trim();
}

function collectResponses(page: Page) {
  let connectionList: RawConnection[] | undefined;
  let stationList: Station[] = [];
  const priceMap = new Map<number, PriceEntry['ceny']>();
  const waiters: Array<() => void> = [];

  page.on('response', (response: Response) => {
    if (!response.url().includes('api-gateway.intercity.pl')) return;
    const method = (response.request().postData() ?? '').match(/"metoda"\s*:\s*"(\w+)"/)?.[1];
    if (method !== 'wyszukajPolaczenia' && method !== 'pobierzStacje' && method !== 'sprawdzCenyLite') return;
    void response.json().then((payload: any) => {
      if (method === 'wyszukajPolaczenia' && Array.isArray(payload?.polaczenia)) {
        connectionList = payload.polaczenia;
        waiters.splice(0).forEach((resolve) => resolve());
      } else if (method === 'pobierzStacje' && Array.isArray(payload?.stacje)) {
        stationList = payload.stacje;
      } else if (method === 'sprawdzCenyLite' && Array.isArray(payload?.cenyPolaczen)) {
        for (const entry of payload.cenyPolaczen as PriceEntry[]) priceMap.set(entry.idPolaczenia, entry.ceny ?? []);
      }
    }).catch(() => undefined);
  });

  return {
    connections: (timeoutMs: number) => new Promise<RawConnection[]>((resolve, reject) => {
      if (connectionList) return resolve(connectionList);
      const timer = setTimeout(() => reject(new Error('timeout')), Math.max(timeoutMs, 1_000));
      waiters.push(() => { clearTimeout(timer); resolve(connectionList!); });
    }),
    stations: () => stationList,
    prices: () => priceMap,
  };
}
