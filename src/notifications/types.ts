import type { AvailabilityCheck, Watch } from '@prisma/client';
import type { AvailabilityResult } from '../checker/types.js';

export interface SeatAvailableNotificationInput {
  watch: Watch;
  result: AvailabilityResult;
  availabilityCheck: AvailabilityCheck;
  detectedAt: Date;
}

export interface NotificationSendResult {
  status: 'sent' | 'failed';
  target?: string;
  message: string;
  errorMessage?: string;
}

export interface Notifier {
  sendSeatAvailable(input: SeatAvailableNotificationInput): Promise<NotificationSendResult>;
  sendTest(): Promise<NotificationSendResult>;
}
