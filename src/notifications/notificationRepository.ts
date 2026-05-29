import type { Notification } from '@prisma/client';
import { prisma } from '../db/client.js';
import type { NotificationSendResult, SeatAvailableNotificationInput } from './types.js';

export async function saveNotificationResult(
  input: SeatAvailableNotificationInput,
  result: NotificationSendResult,
): Promise<Notification> {
  return prisma.notification.create({
    data: {
      watchId: input.watch.id,
      availabilityCheckId: input.availabilityCheck.id,
      channel: 'email',
      target: result.target,
      message: result.message,
      status: result.status,
      errorMessage: result.errorMessage,
    },
  });
}
