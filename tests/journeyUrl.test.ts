import { describe, expect, it } from 'vitest';
import {
  JourneyUrlError,
  parseJourneyUrl,
  parseTicketSummary,
  pickConnection,
  toDirectConnections,
  type RawConnection,
} from '../src/checker/journeyUrl.js';
import { journeyPreviewSchema, watchInputSchema } from '../src/api/watchSchemas.js';

const journeyUrl =
  'https://ebilet.intercity.pl/wybormiejsc?dwyj=2026-11-06&swyj=5100067&sprzy=5100081&time=15%3A36&przy=0&sprzez=&ticket100=1990&ticket50=&polbez=0';

function connection(id: number, number: number, category: string, dep: string, arr: string, trains = 1): RawConnection {
  const train = {
    nrPociagu: number, kategoriaPociagu: category, nazwaPociagu: `Pociąg ${number}`,
    dataWyjazdu: `2026-11-06 ${dep}:00`, dataPrzyjazdu: `2026-11-06 ${arr}:00`, stacjaWyjazdu: 404, stacjaPrzyjazdu: 159,
  };
  return {
    idPolaczenia: id, pociagi: Array.from({ length: trains }, () => train),
    dataWyjazdu: `2026-11-06 ${dep}:00`, dataPrzyjazdu: `2026-11-06 ${arr}:00`,
  };
}

describe('parseJourneyUrl', () => {
  it('turns a journey page URL into a search URL keeping the whitelisted params', () => {
    const parsed = parseJourneyUrl(journeyUrl);
    expect(parsed).toMatchObject({ date: '2026-11-06', time: '15:36', originCode: '5100067', destinationCode: '5100081' });
    expect(parsed.searchUrl).toBe(
      'https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-11-06&swyj=5100067&sprzy=5100081&time=15%3A36&przy=0&sprzez=&ticket100=1990&ticket50=&polbez=0',
    );
  });

  it('accepts a search URL and drops unknown params', () => {
    const parsed = parseJourneyUrl('https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-11-06&swyj=1&sprzy=2&evil=https%3A%2F%2Fx.test');
    expect(parsed.searchUrl).toBe('https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-11-06&swyj=1&sprzy=2');
  });

  it.each([
    ['https://evil.example/wybormiejsc?dwyj=2026-11-06&swyj=1&sprzy=2'],
    ['http://ebilet.intercity.pl/wybormiejsc?dwyj=2026-11-06&swyj=1&sprzy=2'],
    ['https://ebilet.intercity.pl/koszyk?dwyj=2026-11-06&swyj=1&sprzy=2'],
    ['https://ebilet.intercity.pl/wybormiejsc?swyj=1&sprzy=2'],
    ['https://ebilet.intercity.pl/wybormiejsc?dwyj=2026-11-06&sprzy=2'],
    ['https://ebilet.intercity.pl/wybormiejsc?dwyj=2026-11-06&swyj=1&sprzy=2&sprzez=5100010'],
    ['not a url'],
  ])('rejects %s', (input) => {
    expect(() => parseJourneyUrl(input)).toThrow(JourneyUrlError);
  });
});

describe('connections', () => {
  const connections = toDirectConnections([
    connection(3, 40, 'EIC', '17:05', '19:24'),
    connection(1, 2704, 'IC', '15:37', '18:50'),
    connection(2, 1802, 'EIP', '16:05', '18:16', 2),
    connection(4, 100, 'IC', '08:00', '10:00'),
  ]);

  it('keeps direct connections only, formatted and sorted by departure', () => {
    expect(connections.map((c) => c.trainNumber)).toEqual(['IC 100', 'IC 2704', 'EIC 40']);
    expect(connections[1]).toMatchObject({ departureTime: '15:37', arrivalTime: '18:50', trainName: 'Pociąg 2704' });
  });

  it('is exact when departure is within 2 minutes after the URL time', () => {
    const picked = pickConnection(connections, '15:36');
    expect(picked.confidence).toBe('exact');
    expect(picked.connection?.trainNumber).toBe('IC 2704');
  });

  it('guesses the next train when time is a free-form search time', () => {
    const picked = pickConnection(connections, '16:30');
    expect(picked.confidence).toBe('guess');
    expect(picked.connection?.trainNumber).toBe('EIC 40');
  });

  it('falls back to the last connection after the final departure and reports none for empty lists', () => {
    expect(pickConnection(connections, '23:00')).toMatchObject({ confidence: 'guess', connection: { trainNumber: 'EIC 40' } });
    expect(pickConnection([], '10:00')).toEqual({ confidence: 'none' });
  });
});

describe('parseTicketSummary', () => {
  it('reads passengers and discount label from the page header', () => {
    expect(parseTicketSummary('Warszawa Zach. Poznań Gł. 1x Pasażer 1x 51% Studenci do 26 lat / doktoranci do 35 lat ZMIEŃ czw. 05 listopada'))
      .toEqual({ passengers: 1, ticketLabel: '51% Studenci do 26 lat / doktoranci do 35 lat' });
    expect(parseTicketSummary('nic tu nie ma')).toEqual({});
  });
});

describe('API schemas for the journey flow', () => {
  it('validates the preview request', () => {
    expect(journeyPreviewSchema.parse({ url: journeyUrl }).url).toBe(journeyUrl);
    expect(() => journeyPreviewSchema.parse({ url: '' })).toThrow();
  });

  it('accepts optional journey details on a watcher', () => {
    const parsed = watchInputSchema.parse({
      searchUrl: parseJourneyUrl(journeyUrl).searchUrl, origin: 'Warszawa Zach.', destination: 'Poznań Gł.', date: '2026-11-06',
      trainNumber: 'IC 2704', departureTime: '15:37', arrivalTime: '18:50', trainName: 'Zielonogórzanin',
      ticketLabel: '51% Studenci do 26 lat', travelClass: 2, passengers: 1,
    });
    expect(parsed).toMatchObject({ arrivalTime: '18:50', trainName: 'Zielonogórzanin' });
  });
});
