import { Resend } from 'resend';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import type { PurchaseRecord, PurchaseState } from './types.js';

const outcomeLabels: Record<PurchaseState, string> = {
  PREPARING: 'Przygotowanie płatności', WAITING_FOR_BLIK: 'Miejsce czeka na kod BLIK',
  WAITING_AFTER_DEFERRAL: 'Zamówienie oczekuje na płatność — strona bota jest dostępna',
  PAYMENT_PENDING: 'Oczekiwanie na wynik płatności', PAID: 'Zakup potwierdzony',
  DEFERRED: 'Płatność odroczona', EXPIRED: 'Rezerwacja wygasła',
  FAILED: 'Operacja nie powiodła się', UNKNOWN: 'Sprawdź zamówienie na koncie Intercity',
};

export function purchaseDashboardUrl(watchId: string, remote = false): string {
  const url = new URL(env.DASHBOARD_URL);
  url.searchParams.set('watch', watchId);
  if (remote) url.searchParams.set('view', 'intercity');
  return url.toString();
}

export function notifyPurchase(session: PurchaseRecord): void {
  // Notification errors never control the live reservation or trigger another check.
  void sendPurchaseNotification(session).catch(() => console.error('Purchase notification failed'));
}

export async function sendPurchaseNotification(session: PurchaseRecord, retry = 0): Promise<void> {
  let audit: { watchId: string; availabilityCheckId: string | null; channel: string; target?: string; message: string; eventKey: string } | undefined;
  let recorded = false;
  try {
    const current = await prisma.purchaseSession.findUnique({ where: { id: session.id }, include: { watch: true } });
    if (!current || current.state !== session.state) return;
    const eventKey = `purchase/${session.id}/${session.state}`;
    if (await prisma.notification.findFirst({ where: { eventKey, status: 'sent' } })) return;
    const target = current.watch.notificationTarget ?? env.EMAIL_TO;
    const waiting = session.state === 'WAITING_FOR_BLIK' || session.state === 'WAITING_AFTER_DEFERRAL';
    const deferred = session.state === 'WAITING_AFTER_DEFERRAL';
    const label = outcomeLabels[session.state as PurchaseState] ?? 'Sprawdź wynik zamówienia';
    const deadline = new Intl.DateTimeFormat('sv-SE', {
      timeZone: env.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(current.acceptCodeUntil);
    // Any end without a confirmed purchase: the seat is gone and the watcher is stopped.
    const released = ['EXPIRED', 'FAILED', 'DEFERRED', 'UNKNOWN'].includes(session.state);
    const releasedLines = !released ? [] : session.state === 'UNKNOWN' ? [
      'Bot nie trzyma już tej sesji.',
      'Sprawdź najpierw „Moje bilety” na koncie Intercity — płatność mogła przejść.',
      'Jeśli biletu nie ma, wznów watcher w dashboardzie (potwierdź sprawdzenie zamówienia).',
    ] : session.state === 'DEFERRED' ? [
      'Bot nie trzyma już tej sesji.',
      'Nieopłacone zamówienie może jeszcze chwilę czekać w „Moje bilety” na koncie Intercity — zapłać tam, jeśli zdążysz.',
      'Watcher jest zatrzymany. Możesz go wznowić w dashboardzie.',
    ] : [
      'Bot nie trzyma już tej sesji — rezerwacja miejsca została zwolniona.',
      'Watcher jest zatrzymany. Możesz go wznowić w dashboardzie, a bot znów będzie szukał miejsca.',
    ];
    const text = [
      deferred ? label : waiting ? 'Miejsce zarezerwowane — podaj kod BLIK w dashboardzie.' : label,
      ...releasedLines,
      `${current.watch.trainNumber ?? ''}: ${current.watch.origin} → ${current.watch.destination}`,
      `Podróż: ${current.watch.travelDate.toISOString().slice(0, 10)} ${current.watch.departureTime ?? ''}`,
      `Podróżny: ${current.passengerName ?? '—'}`,
      `Miejsce: ${current.seatAssignment}`,
      `Kwota: ${current.price ?? '—'}`,
      ...(waiting ? [`Kod BLIK do: ${deadline} ${env.TIMEZONE}`, 'Potwierdź płatność w aplikacji bankowej.'] : []),
      ...(current.errorMessage ? [current.errorMessage] : []),
      ...(current.orderNumber ? [`Zamówienie: ${current.orderNumber}`] : []),
      purchaseDashboardUrl(current.watchId),
      ...(waiting ? [`Strona bota: ${purchaseDashboardUrl(current.watchId, true)}`] : []),
    ].join('\n');
    audit = { watchId: session.watchId, availabilityCheckId: current.availabilityCheckId, channel: 'email', target, message: text, eventKey };
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !target) throw new Error('Brak konfiguracji maila');
    const result = await new Resend(env.RESEND_API_KEY).emails.send({
      from: env.EMAIL_FROM, to: target,
      subject: `${deferred ? 'Płatność odroczona — strona bota jest dostępna' : waiting ? 'BLIK — miejsce czeka'
        : session.state === 'UNKNOWN' ? 'Sprawdź zakup na koncie Intercity'
        : released ? 'Sesja zakończona — wznów watcher w dashboardzie' : label} · ${current.watch.trainNumber ?? 'Intercity'}`,
      text,
    }, { idempotencyKey: eventKey });
    await prisma.notification.create({ data: {
      ...audit,
      status: result.error ? 'failed' : 'sent', errorMessage: result.error?.message,
    } });
    recorded = true;
    if (result.error) throw new Error('Mail nie został wysłany');
  } catch {
    if (audit && !recorded) {
      await prisma.notification.create({ data: { ...audit, status: 'failed', errorMessage: 'Nie udało się wysłać powiadomienia zakupu.' } })
        .catch(() => console.error('Could not record purchase notification failure'));
    }
    if (retry < 2) {
      const timer = setTimeout(() => { void sendPurchaseNotification(session, retry + 1).catch(() => console.error('Purchase notification failed')); }, retry === 0 ? 5_000 : 15_000);
      timer.unref();
    } else console.error('Purchase notification failed after retries');
  }
}
