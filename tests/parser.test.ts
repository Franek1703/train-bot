import { describe, expect, it } from 'vitest';
import {
  extractSeatAssignment,
  normalizeAvailabilityStatus,
  parseAvailabilityText,
} from '../src/checker/parser.js';

describe('normalizeAvailabilityStatus', () => {
  it('detects available seats', () => {
    expect(normalizeAvailabilityStatus('Dostępne miejsca siedzące')).toBe('AVAILABLE_WITH_SEAT');
  });

  it('detects availability without guaranteed seat', () => {
    expect(normalizeAvailabilityStatus('Bilet dostępny bez gwarancji miejsca')).toBe(
      'AVAILABLE_WITHOUT_SEAT',
    );
  });

  it('detects sold out trains', () => {
    expect(normalizeAvailabilityStatus('Brak miejsc')).toBe('SOLD_OUT');
  });

  it('falls back to unknown for ambiguous text', () => {
    expect(normalizeAvailabilityStatus('Sprawdź szczegóły połączenia')).toBe('UNKNOWN');
  });
});

describe('parseAvailabilityText', () => {
  it('returns normalized flags', () => {
    const result = parseAvailabilityText('Dostępne miejsca siedzące');

    expect(result.status).toBe('AVAILABLE_WITH_SEAT');
    expect(result.available).toBe(true);
    expect(result.seatAvailable).toBe(true);
  });
});

describe('extractSeatAssignment', () => {
  it('detects assigned seat text from the summary page', () => {
    expect(extractSeatAssignment('IC 146\nWagon 8, miejsce 67, Środek\nMiejsce przy stoliku')).toBe(
      'Wagon 8, miejsce 67, Środek',
    );
  });
});
