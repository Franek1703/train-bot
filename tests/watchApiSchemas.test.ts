import { describe, expect, it } from 'vitest';
import { watchInputSchema, watchUpdateSchema } from '../src/api/watchSchemas.js';

describe('watch API schemas', () => {
  it('accepts watcher creation input', () => {
    const parsed = watchInputSchema.parse({
      searchUrl: 'https://ebilet.intercity.pl/wyszukiwanie?x=1',
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
    });

    expect(parsed.origin).toBe('Warszawa Centralna');
    expect(parsed.active).toBe(true);
  });

  it('rejects unsafe check intervals', () => {
    expect(() =>
      watchInputSchema.parse({
        searchUrl: 'https://ebilet.intercity.pl/wyszukiwanie?x=1',
        origin: 'A',
        destination: 'B',
        date: '2026-06-15',
        travelClass: 2,
        passengers: 1,
        seatRequired: true,
        intervalMinutes: 1,
      }),
    ).toThrow();
  });

  it('allows partial watcher updates', () => {
    expect(watchUpdateSchema.parse({ active: false })).toEqual({ active: false });
  });

  it('preserves notification mode by default and accepts explicit BLIK configuration', () => {
    const input = { searchUrl: 'https://ebilet.intercity.pl/wyszukiwanie', origin: 'Poznań', destination: 'Warszawa', date: '2026-10-11', travelClass: 2, passengers: 1 };
    expect(watchInputSchema.parse(input)).toMatchObject({ purchaseMode: 'notify', purchaseConsent: false });
    expect(watchInputSchema.parse({ ...input, purchaseMode: 'blik', purchaseConsent: true })).toMatchObject({ purchaseMode: 'blik', purchaseConsent: true });
    expect(() => watchInputSchema.parse({ ...input, purchaseMode: 'card' })).toThrow();
  });
});
