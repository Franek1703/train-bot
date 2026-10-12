import type { Prisma, Watch } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import type { AvailabilityStatus } from '../checker/types.js';
import type { WatchConfig, WatchInput } from './types.js';
import { PurchaseError, activePurchaseStates } from '../purchases/types.js';

function toTravelDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function syncConfiguredWatches(watches: WatchConfig[]): Promise<Watch[]> {
  const synced: Watch[] = [];

  for (const watch of watches) {
    validatePurchaseConfiguration(watch);
    synced.push(
      await prisma.watch.upsert({
        where: { configKey: watch.id },
        create: {
          configKey: watch.id,
          journeyUrl: watch.searchUrl,
          origin: watch.origin,
          destination: watch.destination,
          travelDate: toTravelDate(watch.date),
          trainNumber: watch.trainNumber,
          departureTime: watch.departureTime,
          travelClass: watch.travelClass,
          passengers: watch.passengers,
          seatRequired: watch.seatRequired,
          checkIntervalMinutes: watch.intervalMinutes,
          active: watch.active,
          notificationChannel: 'email',
          purchaseMode: watch.purchaseMode ?? 'notify',
          purchaseConsent: watch.purchaseConsent ?? false,
        },
        update: {
          journeyUrl: watch.searchUrl,
          origin: watch.origin,
          destination: watch.destination,
          travelDate: toTravelDate(watch.date),
          trainNumber: watch.trainNumber,
          departureTime: watch.departureTime,
          travelClass: watch.travelClass,
          passengers: watch.passengers,
          seatRequired: watch.seatRequired,
          checkIntervalMinutes: watch.intervalMinutes,
          active: watch.active,
          notificationChannel: 'email',
          purchaseMode: watch.purchaseMode ?? 'notify',
          purchaseConsent: watch.purchaseConsent ?? false,
        },
      }),
    );
  }

  return synced;
}

export async function findActiveWatches(): Promise<Watch[]> {
  return prisma.watch.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function findWatches(): Promise<Watch[]> {
  return prisma.watch.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function findWatchById(watchId: string): Promise<Watch | null> {
  return prisma.watch.findUnique({
    where: { id: watchId },
  });
}

export async function findWatchDetails(watchId: string) {
  return prisma.watch.findUnique({
    where: { id: watchId },
    include: {
      availabilityChecks: {
        orderBy: { checkedAt: 'desc' },
        take: 50,
      },
      notifications: {
        orderBy: { sentAt: 'desc' },
        take: 25,
      },
      errors: {
        orderBy: { createdAt: 'desc' },
        take: 25,
      },
      artifacts: {
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
    },
  });
}

export async function createWatch(input: WatchInput): Promise<Watch> {
  validatePurchaseConfiguration(input);
  return prisma.watch.create({
    data: toCreateWatchData(input),
  });
}

export async function updateWatch(watchId: string, input: Partial<WatchInput>): Promise<Watch> {
  await assertWatchMutable(watchId);
  const existing = await findWatchById(watchId);
  if (!existing) throw new PurchaseError('Watch not found', 404);
  validatePurchaseConfiguration({ ...existing, ...input } as WatchInput);
  if (input.active) await assertPurchaseReviewed(watchId);
  return prisma.watch.update({
    where: { id: watchId },
    data: toWatchData(input),
  });
}

export async function setWatchActive(watchId: string, active: boolean): Promise<Watch> {
  if (active) {
    await assertWatchMutable(watchId);
    await assertPurchaseReviewed(watchId);
  }
  return prisma.watch.update({
    where: { id: watchId },
    data: { active, ...(active ? { lastKnownStatus: null } : {}) },
  });
}

export async function deleteWatch(watchId: string): Promise<void> {
  await assertWatchMutable(watchId);
  await prisma.watch.delete({
    where: { id: watchId },
  });

  await rm(path.join(env.ARTIFACTS_DIR, watchId), { recursive: true, force: true });
}

export async function loadAndSyncWatches(configPath: string): Promise<Watch[]> {
  const { loadWatchesConfig } = await import('./watchConfig.js');
  const config = await loadWatchesConfig(configPath);
  return syncConfiguredWatches(config.checks);
}

export async function updateWatchAfterCheck(args: {
  watchId: string;
  status: AvailabilityStatus;
  checkedAt: Date;
  consecutiveErrors: number;
}): Promise<Watch> {
  return prisma.watch.update({
    where: { id: args.watchId },
    data: {
      lastKnownStatus: args.status,
      lastCheckedAt: args.checkedAt,
      consecutiveErrors: args.consecutiveErrors,
    },
  });
}

export async function updateLastNotifiedAt(watchId: string, notifiedAt: Date): Promise<Watch> {
  return prisma.watch.update({
    where: { id: watchId },
    data: { lastNotifiedAt: notifiedAt },
  });
}

function toCreateWatchData(input: WatchInput): Prisma.WatchCreateInput {
  return {
    configKey: input.configKey ?? `dashboard-${randomUUID()}`,
    journeyUrl: input.searchUrl,
    origin: input.origin,
    destination: input.destination,
    travelDate: toTravelDate(input.date),
    trainNumber: input.trainNumber,
    departureTime: input.departureTime,
    travelClass: input.travelClass,
    passengers: input.passengers,
    seatRequired: input.seatRequired,
    checkIntervalMinutes: input.intervalMinutes,
    active: input.active ?? true,
    notificationChannel: 'email',
    notificationTarget: input.notificationTarget,
    purchaseMode: input.purchaseMode ?? 'notify',
    purchaseConsent: input.purchaseConsent ?? false,
  };
}

function toWatchData(input: Partial<WatchInput>): Prisma.WatchUpdateInput {
  return {
    configKey: input.configKey,
    journeyUrl: input.searchUrl,
    origin: input.origin,
    destination: input.destination,
    travelDate: input.date ? toTravelDate(input.date) : undefined,
    trainNumber: input.trainNumber,
    departureTime: input.departureTime,
    travelClass: input.travelClass,
    passengers: input.passengers,
    seatRequired: input.seatRequired,
    checkIntervalMinutes: input.intervalMinutes,
    active: input.active,
    notificationChannel: 'email',
    notificationTarget: input.notificationTarget,
    purchaseMode: input.purchaseMode,
    purchaseConsent: input.purchaseConsent,
  };
}

export function validatePurchaseConfiguration(input: Pick<WatchInput, 'purchaseMode' | 'purchaseConsent'>): void {
  if (input.purchaseMode !== 'blik') return;
  if (!input.purchaseConsent) throw new PurchaseError('Tryb BLIK wymaga zgody na wymagane regulaminy Intercity.', 400);
  if (!env.INTERCITY_EMAIL || !env.INTERCITY_PASSWORD) throw new PurchaseError('Tryb BLIK wymaga skonfigurowanego konta Intercity.', 400);
}

export async function assertWatchMutable(watchId: string): Promise<void> {
  const active = await prisma.purchaseSession.findFirst({ where: { watchId, state: { in: activePurchaseStates } } });
  if (active) throw new PurchaseError('Watcher ma aktywną sesję zakupu. Poczekaj na jej zakończenie.');
}

async function assertPurchaseReviewed(watchId: string): Promise<void> {
  const latest = await prisma.purchaseSession.findFirst({ where: { watchId }, orderBy: { createdAt: 'desc' } });
  if (latest?.state === 'UNKNOWN' && !latest.reviewedAt) {
    throw new PurchaseError('Sprawdź zamówienie na koncie Intercity i potwierdź sprawdzenie przed wznowieniem.');
  }
}
