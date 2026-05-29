import { describe, expect, it } from 'vitest';
import { parseWatchesConfig } from '../src/watches/watchConfig.js';

describe('parseWatchesConfig', () => {
  it('validates a watch config file', () => {
    const config = parseWatchesConfig({
      checks: [
        {
          id: 'watch-1',
          searchUrl:
            'https://ebilet.intercity.pl/wyszukiwanie?dwyj=2026-05-31&swyj=5100081&sprzy=5100067&time=11%3A00&przy=0&sprzez=&ticket100=1010&ticket50=&polbez=0',
          origin: 'Warszawa Centralna',
          destination: 'Gdańsk Główny',
          date: '2026-06-15',
          trainNumber: 'EIP 3500',
          departureTime: '08:25',
          travelClass: 2,
          passengers: 1,
          seatRequired: true,
          intervalMinutes: 5,
          active: true,
        },
      ],
    });

    expect(config.checks).toHaveLength(1);
    expect(config.checks[0]?.id).toBe('watch-1');
    expect(config.checks[0]?.searchUrl).toContain('/wyszukiwanie');
  });

  it('rejects watches without a search URL', () => {
    expect(() =>
      parseWatchesConfig({
        checks: [
          {
            id: 'watch-1',
            origin: 'A',
            destination: 'B',
            date: '2026-06-15',
            travelClass: 2,
            passengers: 1,
            seatRequired: true,
            intervalMinutes: 5,
            active: true,
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects unsafe check intervals', () => {
    expect(() =>
      parseWatchesConfig({
        checks: [
          {
            id: 'watch-1',
            origin: 'A',
            destination: 'B',
            date: '2026-06-15',
            travelClass: 2,
            passengers: 1,
            seatRequired: true,
            intervalMinutes: 1,
            active: true,
          },
        ],
      }),
    ).toThrow();
  });
});
