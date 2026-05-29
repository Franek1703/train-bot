import type { SeatAvailableNotificationInput } from './types.js';

export function formatDetectedAt(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value(
    'minute',
  )} ${timezone}`;
}

export function buildSeatAvailableSubject(input: SeatAvailableNotificationInput): string {
  const train = input.result.trainNumber ?? input.watch.trainNumber ?? 'Train';
  return `Seat available: ${train} ${input.watch.origin} -> ${input.watch.destination}`;
}

export function buildSeatAvailableBody(
  input: SeatAvailableNotificationInput,
  timezone: string,
): string {
  const train = input.result.trainNumber ?? input.watch.trainNumber ?? 'Unknown';
  const departureTime = input.result.departureTime ?? input.watch.departureTime ?? 'Unknown';
  const purchaseUrl = input.result.purchaseUrl ?? 'https://www.intercity.pl/';
  const detectedAt = formatDetectedAt(input.detectedAt, timezone);

  return [
    'Seat available!',
    '',
    `Detected at: ${detectedAt}`,
    '',
    `Train: ${train}`,
    `Route: ${input.watch.origin} -> ${input.watch.destination}`,
    `Travel date: ${input.watch.travelDate.toISOString().slice(0, 10)}`,
    `Departure time: ${departureTime}`,
    `Class: ${input.watch.travelClass}`,
    `Passengers: ${input.watch.passengers}`,
    '',
    'Buy now:',
    purchaseUrl,
  ].join('\n');
}
