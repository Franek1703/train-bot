import { prisma } from '../db/client.js';
import { activePurchaseStates, type PurchaseRepository } from './types.js';

export const purchaseRepository: PurchaseRepository = {
  async create(watchId, seatAssignment, expiresAt, acceptCodeUntil) {
    return prisma.$transaction(async (tx) => {
      await tx.watch.update({ where: { id: watchId }, data: { active: false } });
      return tx.purchaseSession.create({ data: { watchId, seatAssignment, expiresAt, acceptCodeUntil } });
    });
  },
  get: (id) => prisma.purchaseSession.findUnique({ where: { id } }),
  update: (id, data) => prisma.purchaseSession.update({ where: { id }, data }),
  async claimAttempt(id, attemptId, now) {
    const result = await prisma.purchaseSession.updateMany({
      where: { id, state: 'WAITING_FOR_BLIK', acceptCodeUntil: { gt: now } },
      data: { state: 'PAYMENT_PENDING', attemptId, errorMessage: null },
    });
    return result.count === 1;
  },
};

export function latestPurchase(watchId: string) {
  return prisma.purchaseSession.findFirst({ where: { watchId }, orderBy: { createdAt: 'desc' } });
}

export function reviewUnknownPurchase(id: string) {
  return prisma.purchaseSession.update({ where: { id }, data: { reviewedAt: new Date() } });
}

export async function recoverLostPurchases() {
  return prisma.$transaction(async (tx) => {
    const lost = await tx.purchaseSession.findMany({ where: { state: { in: activePurchaseStates } } });
    await tx.purchaseSession.updateMany({
      where: { state: { in: activePurchaseStates } },
      data: { state: 'UNKNOWN', errorMessage: 'Sesja przeglądarki została utracona. Sprawdź zamówienie na koncie Intercity.' },
    });
    await tx.watch.updateMany({ where: { id: { in: lost.map((s) => s.watchId) } }, data: { active: false } });
    return lost.map((s) => ({ ...s, state: 'UNKNOWN' }));
  });
}
