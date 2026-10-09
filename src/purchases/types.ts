export const activePurchaseStates = ['PREPARING', 'WAITING_FOR_BLIK', 'PAYMENT_PENDING'];

export type PurchaseState =
  | 'PREPARING' | 'WAITING_FOR_BLIK' | 'PAYMENT_PENDING'
  | 'PAID' | 'DEFERRED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN';

export interface PurchaseRecord {
  id: string;
  watchId: string;
  availabilityCheckId: string | null;
  state: string;
  passengerName: string | null;
  seatAssignment: string;
  price: string | null;
  expiresAt: Date;
  acceptCodeUntil: Date;
  attemptId: string | null;
  orderNumber: string | null;
  intercityUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PurchasePatch = Partial<Pick<PurchaseRecord,
  'state' | 'passengerName' | 'price' | 'expiresAt' | 'acceptCodeUntil' |
  'attemptId' | 'orderNumber' | 'intercityUrl' | 'errorMessage' | 'availabilityCheckId'>>;

export interface PurchaseRepository {
  create(watchId: string, seatAssignment: string, expiresAt: Date, acceptCodeUntil: Date): Promise<PurchaseRecord>;
  get(id: string): Promise<PurchaseRecord | null>;
  update(id: string, patch: PurchasePatch): Promise<PurchaseRecord>;
  claimAttempt(id: string, attemptId: string, now: Date): Promise<boolean>;
}

export interface PaymentObservation {
  outcome: 'pending' | 'paid' | 'rejected' | 'expired';
  expiresAt?: Date;
  orderNumber?: string;
  intercityUrl?: string;
}

export interface PurchasePage {
  prepare(): Promise<{ passengerName: string; price: string; intercityUrl: string; expiresAt: Date }>;
  observe(): Promise<PaymentObservation>;
  submit(code: string): Promise<void>;
  defer(): Promise<{ confirmed: boolean; intercityUrl?: string; orderNumber?: string }>;
  close(): Promise<void>;
}

export class PurchaseError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
  }
}

// Only for failures proven to happen before clicking the payment button.
export class PaymentNotSubmittedError extends Error {}

export function codeDeadline(expiresAt: Date, now: Date): Date {
  // Infer the start from the site's reservation clock, including preparation time.
  return new Date(Math.min(now.getTime() + 12 * 60_000, expiresAt.getTime() - 3 * 60_000));
}
