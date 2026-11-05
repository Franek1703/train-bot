// Pure helpers for ebilet.intercity.pl journey/search URLs and connection data.
// No Playwright here so everything can be unit tested.

export const INTERCITY_ORIGIN = 'https://ebilet.intercity.pl';
const ALLOWED_PATHS = new Set(['/wybormiejsc', '/wyszukiwanie']);
const ALLOWED_PARAMS = ['dwyj', 'swyj', 'sprzy', 'time', 'przy', 'sprzez', 'ticket100', 'ticket50', 'polbez'] as const;

export class JourneyUrlError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export interface ParsedJourneyUrl {
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm
  originCode: string; // kodEPA
  destinationCode: string; // kodEPA
  params: Array<[string, string]>; // whitelisted query params, original order
  searchUrl: string;
}

export function parseJourneyUrl(input: string): ParsedJourneyUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new JourneyUrlError('Niepoprawny adres URL.');
  }
  if (url.origin !== INTERCITY_ORIGIN) {
    throw new JourneyUrlError('Adres musi pochodzić z https://ebilet.intercity.pl.');
  }
  if (!ALLOWED_PATHS.has(url.pathname.replace(/\/+$/, ''))) {
    throw new JourneyUrlError('Oczekiwano strony „Twoja podróż” (/wybormiejsc) lub wyników wyszukiwania (/wyszukiwanie).');
  }

  const params: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if ((ALLOWED_PARAMS as readonly string[]).includes(key)) params.push([key, value]);
  }
  const get = (key: string) => params.find(([name]) => name === key)?.[1];

  const date = get('dwyj');
  const originCode = get('swyj');
  const destinationCode = get('sprzy');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new JourneyUrlError('W adresie brakuje poprawnej daty (dwyj).');
  if (!originCode || !/^\d+$/.test(originCode)) throw new JourneyUrlError('W adresie brakuje stacji początkowej (swyj).');
  if (!destinationCode || !/^\d+$/.test(destinationCode)) throw new JourneyUrlError('W adresie brakuje stacji docelowej (sprzy).');
  const time = get('time');
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new JourneyUrlError('Niepoprawna godzina (time) w adresie.');
  const via = get('sprzez');
  if (via) throw new JourneyUrlError('Połączenia przez stację pośrednią nie są obsługiwane.');

  const search = new URLSearchParams(params);
  return {
    date,
    time: time || undefined,
    originCode,
    destinationCode,
    params,
    searchUrl: `${INTERCITY_ORIGIN}/wyszukiwanie?${search.toString()}`,
  };
}

// --- Connections (shape of the `wyszukajPolaczenia` response the SPA fetches) ---

export interface RawTrain {
  nrPociagu: number;
  kategoriaPociagu: string;
  nazwaPociagu?: string;
  dataWyjazdu: string; // "YYYY-MM-DD HH:mm:ss"
  dataPrzyjazdu: string;
  stacjaWyjazdu: number;
  stacjaPrzyjazdu: number;
}

export interface RawConnection {
  idPolaczenia: number;
  pociagi: RawTrain[];
  dataWyjazdu: string;
  dataPrzyjazdu: string;
}

export interface DirectConnection {
  connectionId: number;
  trainNumber: string; // "IC 2704"
  trainName?: string;
  date: string;
  departureTime: string;
  arrivalTime: string;
  arrivalDate: string;
}

export function toDirectConnections(connections: RawConnection[]): DirectConnection[] {
  const direct: DirectConnection[] = [];
  for (const connection of connections) {
    if (connection.pociagi?.length !== 1) continue;
    const train = connection.pociagi[0]!;
    const [date, departureTime] = splitDateTime(train.dataWyjazdu);
    const [arrivalDate, arrivalTime] = splitDateTime(train.dataPrzyjazdu);
    if (!date || !departureTime || !arrivalTime) continue;
    direct.push({
      connectionId: connection.idPolaczenia,
      trainNumber: `${train.kategoriaPociagu} ${train.nrPociagu}`.trim(),
      trainName: train.nazwaPociagu?.trim() || undefined,
      date,
      departureTime,
      arrivalTime,
      arrivalDate,
    });
  }
  return direct.sort((a, b) => `${a.date} ${a.departureTime}`.localeCompare(`${b.date} ${b.departureTime}`));
}

function splitDateTime(value: string): [string, string] {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return match ? [match[1]!, match[2]!] : ['', ''];
}

export function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
}

export interface PickedConnection {
  connection?: DirectConnection;
  // 'exact': departure is within 2 minutes after the URL's `time` (the SPA builds it as departure - 1 min).
  confidence: 'exact' | 'guess' | 'none';
}

export function pickConnection(connections: DirectConnection[], time?: string): PickedConnection {
  if (!connections.length) return { confidence: 'none' };
  if (!time) return { connection: connections[0], confidence: 'guess' };
  const target = minutes(time);
  const next = connections.find((connection) => minutes(connection.departureTime) >= target);
  if (!next) return { connection: connections[connections.length - 1], confidence: 'guess' };
  return { connection: next, confidence: minutes(next.departureTime) - target <= 2 ? 'exact' : 'guess' };
}

// --- Page header ("1x Pasażer 1x 51% Studenci do 26 lat ... ZMIEŃ") ---

export function parseTicketSummary(bodyText: string): { passengers?: number; ticketLabel?: string } {
  const text = bodyText.replace(/\s+/g, ' ');
  const match = text.match(/(\d+)x\s+Pasażer\w*\s+(.+?)\s+ZMIEŃ/i);
  if (!match) return {};
  return { passengers: Number(match[1]), ticketLabel: match[2]!.replace(/^\d+x\s+/, '').trim() || undefined };
}

// --- Pinned train (read by the dashboard bookmarklet from the journey page's sessionStorage) ---

export interface PinnedTrain {
  trainNumber: string; // "EIC 40" (category optional when matching)
  departureTime: string; // HH:mm
  date?: string; // YYYY-MM-DD
}

export function findPinnedConnection(connections: DirectConnection[], pin: PinnedTrain, searchDate: string): DirectConnection | undefined {
  const digits = (value: string) => value.replace(/\D+/g, '');
  const wanted = digits(pin.trainNumber);
  return connections.find((connection) =>
    connection.date === (pin.date ?? searchDate) &&
    connection.departureTime === pin.departureTime &&
    digits(connection.trainNumber) === wanted);
}
