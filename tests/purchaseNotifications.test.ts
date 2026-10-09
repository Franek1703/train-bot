import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseRecord } from '../src/purchases/types.js';

const mocks = vi.hoisted(() => ({ find: vi.fn(), findNotification: vi.fn(), createNotification: vi.fn(), send: vi.fn() }));
vi.mock('resend', () => ({ Resend: vi.fn().mockImplementation(() => ({ emails: { send: mocks.send } })) }));
vi.mock('../src/db/client.js', () => ({ prisma: {
  purchaseSession: { findUnique: mocks.find },
  notification: { findFirst: mocks.findNotification, create: mocks.createNotification },
} }));
vi.mock('../src/config/env.js', () => ({ env: {
  DASHBOARD_URL: 'https://dashboard.example/', TIMEZONE: 'Europe/Warsaw',
  RESEND_API_KEY: 'test-key', EMAIL_FROM: 'bot@example.com', EMAIL_TO: 'default@example.com',
} }));

import { sendPurchaseNotification } from '../src/purchases/purchaseNotifications.js';

const session = {
  id: 'purchase-1', watchId: 'watch-1', availabilityCheckId: 'check-1', state: 'WAITING_FOR_BLIK',
  passengerName: 'Test Passenger', seatAssignment: 'Wagon 9, miejsce 17', price: '33,81 zł',
  acceptCodeUntil: new Date('2026-10-09T12:12:44Z'), expiresAt: new Date('2026-10-09T12:15:44Z'),
} as PurchaseRecord;
const watch = {
  notificationTarget: 'watch@example.com', trainNumber: 'IC 8112', origin: 'Poznań', destination: 'Warszawa',
  travelDate: new Date('2026-10-11T00:00:00Z'), departureTime: '15:27',
};

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.find.mockResolvedValue({ ...session, watch });
  mocks.findNotification.mockResolvedValue(null);
  mocks.createNotification.mockResolvedValue({ id: 'notification-1' });
  mocks.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('purchase emails', () => {
  it('sends a dashboard deep link, passenger, price and exact deadline to the watcher target', async () => {
    await sendPurchaseNotification(session);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'watch@example.com',
      text: expect.stringContaining('https://dashboard.example/?watch=watch-1'),
    }), { idempotencyKey: 'purchase/purchase-1/WAITING_FOR_BLIK' });
    const text = mocks.send.mock.calls[0][0].text;
    expect(text).toContain('2026-10-09 14:12:44 Europe/Warsaw');
    expect(text).toContain('33,81 zł');
    expect(text).toContain('Test Passenger');
    expect(text).not.toContain('Purchase purchase-1');
  });

  it('records a Resend error and retries without changing the purchase session', async () => {
    mocks.send.mockResolvedValueOnce({ data: null, error: { message: 'Provider unavailable' } });
    await sendPurchaseNotification(session);
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.createNotification).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }));
  });

  it('records transport failures without exposing raw provider errors', async () => {
    mocks.send.mockRejectedValueOnce(new Error('transport failure'));
    await sendPurchaseNotification(session);
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorMessage: 'Nie udało się wysłać powiadomienia zakupu.' }) }));
  });

  it('does not resend a sent event or send an obsolete waiting email', async () => {
    mocks.findNotification.mockResolvedValueOnce({ id: 'existing' });
    await sendPurchaseNotification(session);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.find.mockResolvedValueOnce({ ...session, state: 'PAID', watch });
    await sendPurchaseNotification(session);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
