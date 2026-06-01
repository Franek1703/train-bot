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
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
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
