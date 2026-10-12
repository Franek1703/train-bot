import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/client.js';
import { purchaseRepository, recoverLostPurchases } from '../src/purchases/purchaseRepository.js';
import { PurchaseManager } from '../src/purchases/purchaseManager.js';
import type { PurchasePage } from '../src/purchases/types.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('BLIK with PostgreSQL transactions and indexes', () => {
  const watchIds: string[] = [];
  beforeAll(() => {
    const testUrl = process.env.TEST_DATABASE_URL!;
    if (process.env.DATABASE_URL !== testUrl || !new URL(testUrl).pathname.endsWith('_blik_test')) {
      throw new Error('DATABASE_URL must equal TEST_DATABASE_URL and use a dedicated *_blik_test database');
    }
  });
  afterEach(async () => { await prisma.watch.deleteMany({ where: { id: { in: watchIds } } }); watchIds.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  async function watch() {
    const row = await prisma.watch.create({ data: {
      configKey: `postgres-test-${randomUUID()}`, origin: 'Poznań Główny', destination: 'Warszawa Zachodnia',
      travelDate: new Date('2026-10-11'), purchaseMode: 'blik', purchaseConsent: true,
    } });
    watchIds.push(row.id);
    return row;
  }
  const expiry = () => new Date(Date.now() + 15 * 60_000);
  const deadline = () => new Date(Date.now() + 12 * 60_000);

  it('allows one active checkout and rolls back stopping the competing watcher', async () => {
    const first = await watch(); const second = await watch();
    await purchaseRepository.create(first.id, 'Wagon 9, miejsce 17', expiry(), deadline());
    await expect(purchaseRepository.create(second.id, 'Wagon 9, miejsce 18', expiry(), deadline())).rejects.toMatchObject({ code: 'P2002' });
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: first.id } })).active).toBe(false);
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: second.id } })).active).toBe(true);
    expect(await prisma.purchaseSession.count({ where: { watchId: second.id } })).toBe(0);
  });

  it('atomically claims only one concurrent attempt and rejects expired codes', async () => {
    const row = await watch();
    const session = await purchaseRepository.create(row.id, 'Wagon 9, miejsce 17', expiry(), deadline());
    await purchaseRepository.update(session.id, { state: 'WAITING_FOR_BLIK' });
    const claims = await Promise.all([1, 2].map(() => purchaseRepository.claimAttempt(session.id, randomUUID(), new Date())));
    expect(claims.sort()).toEqual([false, true]);
    await purchaseRepository.update(session.id, { state: 'WAITING_FOR_BLIK', acceptCodeUntil: new Date(0) });
    expect(await purchaseRepository.claimAttempt(session.id, randomUUID(), new Date())).toBe(false);
  });

  it('persists automatic deferral at the 12 minute deadline with the watcher stopped', async () => {
    const row = await watch(); let now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const page: PurchasePage = {
      prepare: async () => ({ passengerName: 'Test Passenger', price: '33,81 zł', intercityUrl: 'https://ebilet.intercity.pl/', expiresAt }),
      submit: vi.fn(), observe: async () => ({ outcome: 'pending' }),
      defer: vi.fn(async () => ({ confirmed: true, orderNumber: 'TEST-DEFERRED' })), close: vi.fn(async () => {}),
    };
    const manager = new PurchaseManager(purchaseRepository, () => {}, () => now);
    try {
      const session = await manager.prepare(row.id, 'Wagon 9, miejsce 17', expiresAt, page);
      expect(session.acceptCodeUntil.getTime() - now.getTime()).toBe(12 * 60_000);
      now = new Date(session.acceptCodeUntil);
      await manager.tick();
      expect(await purchaseRepository.get(session.id)).toMatchObject({ state: 'WAITING_AFTER_DEFERRAL', orderNumber: 'TEST-DEFERRED', deferredAt: now });
      expect(page.defer).toHaveBeenCalledOnce(); expect(page.submit).not.toHaveBeenCalled();
      expect(manager.busy).toBe(true);
      const second = await watch();
      await expect(purchaseRepository.create(second.id, 'seat', expiry(), deadline())).rejects.toMatchObject({ code: 'P2002' });
      expect((await prisma.watch.findUniqueOrThrow({ where: { id: row.id } })).active).toBe(false);
    } finally { await manager.shutdown(); }
  });

  it.each(['PAYMENT_PENDING', 'WAITING_AFTER_DEFERRAL'])('recovers lost %s as UNKNOWN and releases the database checkout lock', async (state) => {
    const row = await watch();
    const session = await purchaseRepository.create(row.id, 'Wagon 9, miejsce 17', expiry(), deadline());
    await purchaseRepository.update(session.id, { state: state as 'PAYMENT_PENDING' | 'WAITING_AFTER_DEFERRAL' });
    expect(await recoverLostPurchases()).toEqual([expect.objectContaining({ id: session.id, state: 'UNKNOWN' })]);
    expect(await purchaseRepository.get(session.id)).toMatchObject({ state: 'UNKNOWN' });
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: row.id } })).active).toBe(false);
    const second = await watch();
    await expect(purchaseRepository.create(second.id, 'Wagon 9, miejsce 18', expiry(), deadline())).resolves.toMatchObject({ state: 'PREPARING' });
  });
});
