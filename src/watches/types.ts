export interface WatchConfig {
  id: string;
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
}

export interface WatchesConfigFile {
  checks: WatchConfig[];
}
