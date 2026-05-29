import type { AvailabilityCheck, Watch } from '@prisma/client';
import type { AvailabilityResult } from '../checker/types.js';

export interface SeatAvailableNotificationInput {
  watch: Watch;
  result: AvailabilityResult;
  availabilityCheck: AvailabilityCheck;
  detectedAt: Date;
}

export async function notifySeatAvailable(input: SeatAvailableNotificationInput): Promise<void> {
  console.log(
    `Seat available for ${input.watch.trainNumber ?? 'watched train'} detected at ${input.detectedAt.toISOString()}. Email notifier is not implemented yet.`,
  );
}

export async function sendTestNotification(): Promise<void> {
  console.log('Email notifications are not implemented yet.');
}
