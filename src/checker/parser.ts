import type { AvailabilityResult, AvailabilityStatus } from './types.js';

const AVAILABLE_WITH_SEAT_PATTERNS = [
  /dostępne miejsca siedzące/i,
  /miejsca siedzące dostępne/i,
  /seat.*available/i,
  /available.*seat/i,
  /kup bilet/i,
];

const AVAILABLE_WITHOUT_SEAT_PATTERNS = [
  /bez gwarancji miejsca/i,
  /brak gwarancji miejsca/i,
  /without.*seat/i,
];

const SOLD_OUT_PATTERNS = [
  /brak miejsc/i,
  /wyprzedane/i,
  /sold out/i,
  /niedostępne/i,
  /brak biletów/i,
];

export function normalizeAvailabilityStatus(rawStatus: string): AvailabilityStatus {
  const text = rawStatus.trim();

  if (!text) {
    return 'UNKNOWN';
  }

  if (AVAILABLE_WITHOUT_SEAT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'AVAILABLE_WITHOUT_SEAT';
  }

  if (AVAILABLE_WITH_SEAT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'AVAILABLE_WITH_SEAT';
  }

  if (SOLD_OUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'SOLD_OUT';
  }

  return 'UNKNOWN';
}

export function resultFromStatus(
  status: AvailabilityStatus,
  details: Partial<AvailabilityResult> = {},
): AvailabilityResult {
  return {
    status,
    available: status === 'AVAILABLE_WITH_SEAT' || status === 'AVAILABLE_WITHOUT_SEAT',
    seatAvailable: status === 'AVAILABLE_WITH_SEAT',
    ...details,
  };
}

export function parseAvailabilityText(rawStatus: string): AvailabilityResult {
  return resultFromStatus(normalizeAvailabilityStatus(rawStatus), { rawStatus });
}

export function extractSeatAssignment(text: string): string | undefined {
  return text
    .match(/Wagon\s+\d+,\s*miejsce\s+\d+(?:,\s*[^\n\r]+)?/i)?.[0]
    ?.replace(/\s+/g, ' ')
    .trim();
}
