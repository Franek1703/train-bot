import type { Watch } from '@prisma/client';

export type AvailabilityStatus =
  | 'AVAILABLE_WITH_SEAT'
  | 'AVAILABLE_WITHOUT_SEAT'
  | 'SOLD_OUT'
  | 'TRAIN_NOT_FOUND'
  | 'SEARCH_FAILED'
  | 'UNKNOWN';

export interface AvailabilityResult {
  status: AvailabilityStatus;
  available: boolean;
  seatAvailable: boolean;
  trainNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
  price?: string;
  purchaseUrl?: string;
  rawStatus?: string;
  rawPayload?: unknown;
  errorMessage?: string;
  screenshotPath?: string;
  durationMs?: number;
}

export interface AvailabilityChecker {
  checkAvailability(watch: Watch): Promise<AvailabilityResult>;
}
