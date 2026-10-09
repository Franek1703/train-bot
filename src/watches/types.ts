export interface WatchConfig {
  id: string;
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
  purchaseMode?: 'notify' | 'blik';
  purchaseConsent?: boolean;
}

export interface WatchesConfigFile {
  checks: WatchConfig[];
}

export interface WatchInput {
  configKey?: string;
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
  active?: boolean;
  notificationTarget?: string;
  purchaseMode?: 'notify' | 'blik';
  purchaseConsent?: boolean;
}
