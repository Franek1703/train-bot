import { describe, expect, it } from 'vitest';
import {
  buildSeatAvailableBody,
  buildSeatAvailableSubject,
  formatDetectedAt,
} from '../src/notifications/emailFormatter.js';

const notificationInput = {
  watch: {
    id: 'watch-1',
    origin: 'Warszawa Centralna',
    destination: 'Gdańsk Główny',
    travelDate: new Date('2026-06-15T00:00:00.000Z'),
    trainNumber: 'EIP 3500',
    departureTime: '08:25',
    travelClass: 2,
    passengers: 1,
  },
  result: {
    status: 'AVAILABLE_WITH_SEAT',
    available: true,
    seatAvailable: true,
    trainNumber: 'EIP 3500',
    departureTime: '08:25',
    rawStatus: 'Wagon 8, miejsce 67, Środek',
    purchaseUrl: 'https://www.intercity.pl/',
  },
  availabilityCheck: {
    id: 'check-1',
  },
  detectedAt: new Date('2026-06-15T12:32:00.000Z'),
} as Parameters<typeof buildSeatAvailableSubject>[0];

describe('formatDetectedAt', () => {
  it('formats detection time in the requested timezone', () => {
    expect(formatDetectedAt(new Date('2026-06-15T12:32:00.000Z'), 'Europe/Warsaw')).toBe(
      '2026-06-15 14:32 Europe/Warsaw',
    );
  });
});

describe('email formatting', () => {
  it('builds the expected subject', () => {
    expect(buildSeatAvailableSubject(notificationInput)).toBe(
      'Seat available: EIP 3500 Warszawa Centralna -> Gdańsk Główny',
    );
  });

  it('includes detection time and train details in the body', () => {
    const body = buildSeatAvailableBody(notificationInput, 'Europe/Warsaw');

    expect(body).toContain('Detected at: 2026-06-15 14:32 Europe/Warsaw');
    expect(body).toContain('Train: EIP 3500');
    expect(body).toContain('Route: Warszawa Centralna -> Gdańsk Główny');
    expect(body).toContain('Travel date: 2026-06-15');
    expect(body).toContain('Departure time: 08:25');
    expect(body).toContain('Class: 2');
    expect(body).toContain('Passengers: 1');
    expect(body).toContain('Seat: Wagon 8, miejsce 67, Środek');
    expect(body).toContain('https://www.intercity.pl/');
  });
});
