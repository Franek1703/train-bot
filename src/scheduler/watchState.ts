import type { Watch } from '@prisma/client';
import type { AvailabilityStatus } from '../checker/types.js';

export function isWatchDueForCheck(watch: Watch, now = new Date()): boolean {
  if (!watch.lastCheckedAt) {
    return true;
  }

  const intervalMs = watch.checkIntervalMinutes * 60 * 1000;
  return now.getTime() - watch.lastCheckedAt.getTime() >= intervalMs;
}

export function shouldSendNotification(args: {
  previousStatus: string | null;
  currentStatus: AvailabilityStatus;
}): boolean {
  return (
    args.currentStatus === 'AVAILABLE_WITH_SEAT' &&
    args.previousStatus !== 'AVAILABLE_WITH_SEAT'
  );
}

export function nextConsecutiveErrors(watch: Watch, status: AvailabilityStatus): number {
  return status === 'SEARCH_FAILED' ? watch.consecutiveErrors + 1 : 0;
}
