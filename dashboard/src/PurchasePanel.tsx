import { useEffect, useState } from 'react';
import { apiGet, apiSend, type PurchaseSession, type Watch } from './api';

const labels: Record<PurchaseSession['state'], string> = {
  PREPARING: 'Przygotowujemy płatność',
  WAITING_FOR_BLIK: 'Miejsce czeka — podaj kod BLIK',
  PAYMENT_PENDING: 'Potwierdź płatność w aplikacji bankowej. Czekamy na wynik Intercity.',
  PAID: 'Zakup potwierdzony',
  DEFERRED: 'Intercity potwierdziło „Zapłać później”',
  EXPIRED: 'Rezerwacja wygasła',
  FAILED: 'Nie udało się zakończyć operacji',
  UNKNOWN: 'Sprawdź wynik zamówienia na koncie Intercity',
};

export function PurchasePanel({ watch, onAccountState }: {
  watch: Watch;
  onAccountState: (busy: boolean, state?: PurchaseSession['state']) => void;
}) {
  const [purchase, setPurchase] = useState<PurchaseSession | null>(null);
  const [clock, setClock] = useState({ server: Date.now(), client: Date.now() });
  const [now, setNow] = useState(Date.now());
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await apiGet<{ purchase: PurchaseSession | null; serverTime: string; accountBusy: boolean }>(`/watches/${watch.id}/purchase`);
        if (cancelled) return;
        setPurchase(result.purchase);
        setClock({ server: Date.parse(result.serverTime), client: Date.now() });
        setConnected(true);
        onAccountState(result.accountBusy, result.purchase?.state);
      } catch {
        if (!cancelled) setConnected(false);
      } finally {
        if (!cancelled) timeout = setTimeout(() => void poll(), 2_000);
      }
    }
    void poll();
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    return () => { cancelled = true; clearTimeout(timeout); clearInterval(ticker); };
  }, [watch.id, onAccountState]);

  useEffect(() => {
    if (purchase?.state !== 'WAITING_FOR_BLIK') setCode('');
  }, [purchase?.state]);

  const serverNow = clock.server + now - clock.client;
  const seconds = purchase ? Math.max(0, Math.ceil((Date.parse(purchase.acceptCodeUntil) - serverNow) / 1_000)) : 0;
  const canPay = connected && purchase?.state === 'WAITING_FOR_BLIK' && seconds > 0 && !sending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!purchase || !canPay || !/^\d{6}$/.test(code)) return;
    const inputCode = code;
    setCode('');
    setSending(true);
    setNotice('');
    try {
      await apiSend(`/purchases/${purchase.id}/blik`, 'POST', { code: inputCode, attemptId: crypto.randomUUID() });
      setNotice('Kod wysłany. Potwierdź płatność w aplikacji bankowej.');
      setPurchase({ ...purchase, state: 'PAYMENT_PENDING' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Nie udało się wysłać kodu.');
      setConnected(false); // A fresh server response is required before another attempt.
    } finally { setSending(false); }
  }

  if (!purchase && watch.purchaseMode !== 'blik') return null;
  return (
    <section className="purchase-panel" aria-label="Płatność BLIK">
      <h4>Płatność BLIK</h4>
      {!purchase ? <p>Po znalezieniu miejsca bot przygotuje płatność i wyśle mail z linkiem tutaj.</p> : <>
        <p role="status"><strong>{labels[purchase.state]}</strong></p>
        <dl>
          <dt>Podróż</dt><dd>{watch.travelDate.slice(0, 10)} · {watch.departureTime} · klasa {watch.travelClass}</dd>
          <dt>Podróżny</dt><dd>{purchase.passengerName ?? '—'}</dd>
          <dt>Miejsce</dt><dd>{purchase.seatAssignment}</dd>
          <dt>Do zapłaty</dt><dd>{purchase.price ?? '—'}</dd>
          {purchase.orderNumber && <><dt>Zamówienie</dt><dd>{purchase.orderNumber}</dd></>}
        </dl>
        {purchase.state === 'WAITING_FOR_BLIK' && <>
          <p className="purchase-timer">Czas na podanie kodu: {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
          <p className="muted">Po tym czasie bot wybierze „Zapłać później”.</p>
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="blik-code">Kod BLIK</label>
            <input id="blik-code" type="password" inputMode="numeric" autoComplete="off" maxLength={6} pattern="[0-9]{6}" value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!canPay} required />
            <button type="submit" disabled={!canPay || !/^\d{6}$/.test(code)}>Zapłać {purchase.price}</button>
          </form>
        </>}
        {purchase.errorMessage && <p role="alert">{purchase.errorMessage}</p>}
        {purchase.state === 'DEFERRED' && <p>Odroczenie nie jest potwierdzeniem zakupu. Aktualny termin i stan sprawdź w Intercity.</p>}
        {purchase.intercityUrl && <a href={purchase.intercityUrl} target="_blank" rel="noreferrer">Otwórz Intercity</a>}
      </>}
      {!connected && <p role="status">Odświeżamy połączenie z backendem. Wysyłanie kodu jest wstrzymane.</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
