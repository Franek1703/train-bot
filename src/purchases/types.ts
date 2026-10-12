export const activePurchaseStates = ['PREPARING', 'WAITING_FOR_BLIK', 'WAITING_AFTER_DEFERRAL', 'PAYMENT_PENDING'];

export type PurchaseState =
  | 'PREPARING' | 'WAITING_FOR_BLIK' | 'WAITING_AFTER_DEFERRAL' | 'PAYMENT_PENDING'
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
  deferredAt?: Date | null;
}

export type PurchasePatch = Partial<Pick<PurchaseRecord,
  'state' | 'passengerName' | 'price' | 'expiresAt' | 'acceptCodeUntil' |
  'attemptId' | 'orderNumber' | 'intercityUrl' | 'errorMessage' | 'availabilityCheckId' | 'deferredAt'>>;

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
  defer(): Promise<{ confirmed: boolean; intercityUrl?: string; orderNumber?: string; expiresAt?: Date }>;
  resumeDeferred?(orderNumber: string | null): Promise<{ expiresAt?: Date }>;
  readCode?(): Promise<string>;
  remote?: RemotePage;
  close(): Promise<void>;
}

export interface RemoteTarget {
  id: string; label: string; kind: 'click' | 'input' | 'select'; sensitive: boolean;
  x: number; y: number; width: number; height: number;
  options?: Array<{ value: string; label: string }>;
}
export interface RemoteFrame {
  id: string; image: string; width: number; height: number; targets: RemoteTarget[];
}
export type RemoteAction = { frameId: string } & (
  | { kind: 'click'; targetId: string }
  | { kind: 'fill'; targetId: string; text: string }
  | { kind: 'select'; targetId: string; value: string }
  | { kind: 'scroll'; deltaY: number }
  | { kind: 'key'; key: 'Tab' | 'Escape' | 'Backspace' | 'ArrowDown' | 'ArrowUp' | 'Enter' }
);
export type RemoteIntent = 'submit' | 'defer' | 'normal';
export interface RemotePage {
  frame(): Promise<RemoteFrame>;
  action(action: RemoteAction, intercept: (intent: RemoteIntent) => Promise<void>): Promise<void>;
  invalidate(): void;
}

export class PurchaseError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
  }
}

// Only for failures proven to happen before clicking the payment button.
export class PaymentNotSubmittedError extends Error {}

// Messages contain only our fixed diagnostics, never browser errors or input values.
export class PurchasePreparationError extends Error {}

export function codeDeadline(expiresAt: Date, now: Date): Date {
  // Infer the start from the site's reservation clock, including preparation time.
  return new Date(Math.min(now.getTime() + 12 * 60_000, expiresAt.getTime() - 3 * 60_000));
}
