import type { AvailabilityCheck, Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { AvailabilityResult } from './types.js';

export async function saveAvailabilityCheck(
  watchId: string,
  result: AvailabilityResult,
): Promise<AvailabilityCheck> {
  return prisma.availabilityCheck.create({
    data: {
      watchId,
      status: result.status,
      available: result.available,
      seatAvailable: result.seatAvailable,
      price: result.price,
      purchaseUrl: result.purchaseUrl,
      trainNumber: result.trainNumber,
      departureTime: result.departureTime,
      arrivalTime: result.arrivalTime,
      rawStatus: result.rawStatus,
      rawPayload: result.rawPayload as Prisma.InputJsonValue | undefined,
      errorMessage: result.errorMessage,
      screenshotPath: result.screenshotPath,
      durationMs: result.durationMs,
    },
  });
}
