import type { Watch } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { AvailabilityStatus } from '../checker/types.js';
import type { WatchConfig } from './types.js';

function toTravelDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function syncConfiguredWatches(watches: WatchConfig[]): Promise<Watch[]> {
  const synced: Watch[] = [];

  for (const watch of watches) {
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
