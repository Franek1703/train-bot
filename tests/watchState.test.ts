import { describe, expect, it } from 'vitest';
import { isWatchDueForCheck, shouldSendNotification } from '../src/scheduler/watchState.js';

const baseWatch = {
  checkIntervalMinutes: 5,
  lastCheckedAt: null,
  consecutiveErrors: 0,
} as Parameters<typeof isWatchDueForCheck>[0];

describe('isWatchDueForCheck', () => {
  it('treats never-checked watches as due', () => {
    expect(isWatchDueForCheck(baseWatch)).toBe(true);
  });

  it('respects per-watch intervals', () => {
    const now = new Date('2026-06-15T12:05:00.000Z');
    const watch = {
      ...baseWatch,
      lastCheckedAt: new Date('2026-06-15T12:01:00.000Z'),
    };

    expect(isWatchDueForCheck(watch, now)).toBe(false);
  });
});

describe('shouldSendNotification', () => {
  it('sends when a watch transitions into available with seat', () => {
    expect(
      shouldSendNotification({
        previousStatus: 'SOLD_OUT',
        currentStatus: 'AVAILABLE_WITH_SEAT',
      }),
    ).toBe(true);
  });

  it('does not send duplicate available notifications', () => {
    expect(
      shouldSendNotification({
        previousStatus: 'AVAILABLE_WITH_SEAT',
        currentStatus: 'AVAILABLE_WITH_SEAT',
      }),
    ).toBe(false);
  });
});
