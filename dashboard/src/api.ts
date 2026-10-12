const API_BASE_URL = resolveApiBaseUrl();

export interface Watch {
  id: string;
  journeyUrl?: string;
  origin: string;
  destination: string;
  travelDate: string;
  trainNumber?: string;
  departureTime?: string;
  travelClass: number;
  passengers: number;
  seatRequired: boolean;
  checkIntervalMinutes: number;
  active: boolean;
  lastKnownStatus?: string;
  lastCheckedAt?: string;
  lastNotifiedAt?: string;
  consecutiveErrors: number;
  purchaseMode: 'notify' | 'blik';
  purchaseConsent: boolean;
}

export interface AvailabilityCheck {
  id: string;
  checkedAt: string;
  status: string;
  seatAvailable?: boolean;
  errorMessage?: string;
  screenshotPath?: string;
  durationMs?: number;
}

export interface WatchError {
  id: string;
  watchId: string;
  availabilityCheckId?: string;
  status: string;
  message: string;
  currentUrl?: string;
  pageTitle?: string;
  bodyPreview?: string;
  logArtifactId?: string;
  screenshotArtifactId?: string;
  diagnosticArtifactId?: string;
  createdAt: string;
  watch?: Watch;
}

export interface WatchDetails extends Watch {
  availabilityChecks: AvailabilityCheck[];
  notifications: Array<{ id: string; sentAt: string; status: string; target?: string }>;
  errors: WatchError[];
  artifacts: Array<{ id: string; kind: string; label?: string; createdAt: string }>;
}

export interface WatchInput {
  searchUrl: string;
  origin: string;
  destination: string;
  date: string;
  trainNumber?: string;
  departureTime?: string;
  travelClass: number;
  passengers: number;
  seatRequired: boolean;
  intervalMinutes: number;
  active: boolean;
  notificationTarget?: string;
  purchaseMode: 'notify' | 'blik';
  purchaseConsent: boolean;
}

export interface PurchaseSession {
  id: string;
  watchId: string;
  state: 'PREPARING' | 'WAITING_FOR_BLIK' | 'WAITING_AFTER_DEFERRAL' | 'PAYMENT_PENDING' | 'PAID' | 'DEFERRED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN';
  passengerName: string | null;
  seatAssignment: string;
  price: string | null;
  expiresAt: string;
  acceptCodeUntil: string;
  errorMessage: string | null;
  intercityUrl: string | null;
  orderNumber: string | null;
  summaryScreenshotArtifactId: string | null;
  browserAvailable: boolean;
  deferredAt: string | null;
}

export interface RemoteTarget {
  id: string; label: string; kind: 'click' | 'input' | 'select'; sensitive: boolean;
  x: number; y: number; width: number; height: number;
  options?: Array<{ value: string; label: string }>;
}
export interface BrowserFrame {
  frame: { id: string; image: string; width: number; height: number; targets: RemoteTarget[] };
  ownsControl: boolean; controlBusy: boolean; canControl: boolean; state: PurchaseSession['state'];
}

// crypto.randomUUID is unavailable on ordinary LAN HTTP addresses.
export function newAttemptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function browserRequest<T>(purchaseId: string, route: string, method = 'GET', token?: string, body?: unknown): Promise<T> {
  return request<T>(`/purchases/${purchaseId}/browser/${route}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function artifactUrl(artifactId: string): string {
  return `${API_BASE_URL}/artifacts/${artifactId}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const payload = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new ApiError(payload.error ?? `Request failed with ${response.status}`, response.status);
  }

  return payload as T;
}

function resolveApiBaseUrl(): string {
  const configuredUrl = import.meta.env.VITE_API_BASE_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  return `${window.location.protocol}//${window.location.hostname}:3001`;
}
