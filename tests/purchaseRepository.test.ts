import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watchUpdate: vi.fn(), watchUpdateMany: vi.fn(), sessionCreate: vi.fn(), sessionFindMany: vi.fn(),
  sessionUpdateMany: vi.fn(),
  env: { INTERCITY_EMAIL: 'test@example.com' as string | undefined, INTERCITY_PASSWORD: 'test-password' as string | undefined },
}));
vi.mock('../src/config/env.js', () => ({ env: mocks.env }));
vi.mock('../src/db/client.js', () => {
  const tx = {
    watch: { update: mocks.watchUpdate, updateMany: mocks.watchUpdateMany },
    purchaseSession: { create: mocks.sessionCreate, findMany: mocks.sessionFindMany, updateMany: mocks.sessionUpdateMany },
  };
  return { prisma: { ...tx, $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx) } };
});

import { purchaseRepository, recoverLostPurchases } from '../src/purchases/purchaseRepository.js';
import { validatePurchaseConfiguration } from '../src/watches/watchRepository.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.INTERCITY_EMAIL = 'test@example.com';
  mocks.env.INTERCITY_PASSWORD = 'test-password';
});

describe('purchase persistence and recovery', () => {
  it('stops the watcher in the transaction creating the purchase session', async () => {
    mocks.sessionCreate.mockResolvedValue({ id: 'purchase-1' });
    const expiry = new Date('2026-10-09T12:15:00Z');
    const deadline = new Date('2026-10-09T12:12:00Z');
    await purchaseRepository.create('watch-1', 'seat', expiry, deadline);
    expect(mocks.watchUpdate).toHaveBeenCalledWith({ where: { id: 'watch-1' }, data: { active: false } });
    expect(mocks.sessionCreate).toHaveBeenCalledWith({ data: { watchId: 'watch-1', seatAssignment: 'seat', expiresAt: expiry, acceptCodeUntil: deadline } });
  });

  it('recovers active sessions as unknown and keeps affected watchers stopped', async () => {
    mocks.sessionFindMany.mockResolvedValue([{ id: 'purchase-1', watchId: 'watch-1', state: 'PAYMENT_PENDING' }]);
    const recovered = await recoverLostPurchases();
    expect(recovered).toEqual([{ id: 'purchase-1', watchId: 'watch-1', state: 'UNKNOWN' }]);
    expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'UNKNOWN' }) }));
    expect(mocks.watchUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ['watch-1'] } }, data: { active: false } });
  });

  it('requires consent and an Intercity account only for BLIK mode', () => {
    expect(() => validatePurchaseConfiguration({ purchaseMode: 'notify' })).not.toThrow();
    expect(() => validatePurchaseConfiguration({ purchaseMode: 'blik', purchaseConsent: false })).toThrow('zgody');
    mocks.env.INTERCITY_PASSWORD = undefined;
    expect(() => validatePurchaseConfiguration({ purchaseMode: 'blik', purchaseConsent: true })).toThrow('konta');
    mocks.env.INTERCITY_PASSWORD = 'test-password';
    expect(() => validatePurchaseConfiguration({ purchaseMode: 'blik', purchaseConsent: true })).not.toThrow();
  });
});
