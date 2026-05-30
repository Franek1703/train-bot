import type { Prisma, Watch } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import type { AvailabilityStatus } from '../checker/types.js';
import type { WatchConfig, WatchInput } from './types.js';

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

export async function createWatch(input: WatchInput): Promise<Watch> {
  return prisma.watch.create({
    data: toCreateWatchData(input),
  });
}

export async function updateWatch(watchId: string, input: Partial<WatchInput>): Promise<Watch> {
  return prisma.watch.update({
    where: { id: watchId },
    data: toWatchData(input),
  });
}

export async function setWatchActive(watchId: string, active: boolean): Promise<Watch> {
  return prisma.watch.update({
    where: { id: watchId },
    data: { active },
  });
}

export async function deleteWatch(watchId: string): Promise<void> {
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
  };
}
