import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search } from 'lucide-react';
import { buildBookmarklet, type IncomingJourney } from './bookmarklet';
import { previewJourney, type JourneyConnection, type JourneyPreview, type WatchInput } from './api';

interface Props {
  busy: boolean;
  onCreate: (payload: WatchInput) => Promise<void>;
  incoming?: IncomingJourney;
}

const formatPrice = (price: number) => `${price.toFixed(2).replace('.', ',')} zł`;
const formatDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('pl-PL', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });

export function JourneyLinkForm({ busy, onCreate, incoming }: Props) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<JourneyPreview>();
  const [connectionId, setConnectionId] = useState<number>();
  const [travelClass, setTravelClass] = useState(2);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [seatRequired, setSeatRequired] = useState(true);
  const [blik, setBlik] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);

  const connection: JourneyConnection | undefined = preview
    ? preview.alternatives.find((item) => item.connectionId === connectionId) ?? preview.selected
    : undefined;

  const latestRequest = useRef(0);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);
  const bookmarklet = buildBookmarklet(window.location.origin);
  // React blocks javascript: hrefs in JSX, so the bookmarklet link is set on the element directly.
  useEffect(() => { bookmarkletRef.current?.setAttribute('href', bookmarklet); }, [bookmarklet]);

  useEffect(() => {
    if (!incoming) return;
    setUrl(incoming.url);
    void load(incoming.url, incoming.train);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  async function load(value: string, train?: IncomingJourney['train']) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError('');
    setPreview(undefined);
    try {
      const result = await previewJourney(trimmed, train);
      if (requestId !== latestRequest.current) return;
      setPreview(result);
      setConnectionId(result.selected.connectionId);
    } catch (reason) {
      if (requestId !== latestRequest.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (!preview || !connection) return;
    setSaving(true);
    setError('');
    try {
      await onCreate({
        searchUrl: preview.searchUrl,
        origin: preview.origin,
        destination: preview.destination,
        date: connection.date,
        trainNumber: connection.trainNumber,
        trainName: connection.trainName,
        departureTime: connection.departureTime,
        arrivalTime: connection.arrivalTime,
        ticketLabel: preview.ticketLabel,
        travelClass,
        passengers: preview.passengers ?? 1,
        seatRequired,
        intervalMinutes,
        active: true,
        purchaseMode: blik ? 'blik' : 'notify',
        purchaseConsent: blik && consent,
      });
      setUrl('');
      setPreview(undefined);
      setBlik(false);
      setConsent(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const classPrice = connection?.prices.find((price) => price.travelClass === travelClass);

  return (
    <form onSubmit={(event) => void approve(event)} className="watch-form">
      <h3>Add watcher</h3>
      <p className="muted">
        Na stronie „Twoja podróż” kliknij zakładkę <a ref={bookmarkletRef} className="bookmarklet" onClick={(event) => event.preventDefault()}>➕ Train Bot</a>
        {' '}(przeciągnij ją na pasek zakładek). Dokładny pociąg zostanie przesłany tutaj. Samo wklejenie linku też działa, ale link nie zawiera wybranego pociągu.
      </p>
      <div className="link-row">
        <input
          placeholder="https://ebilet.intercity.pl/wybormiejsc?dwyj=…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text');
            if (pasted) { setUrl(pasted); void load(pasted); event.preventDefault(); }
          }}
          aria-label="Link do podróży"
        />
        <button type="button" disabled={loading || !url.trim()} onClick={() => void load(url)}>
          {loading ? <Loader2 size={16} className="spin" /> : <Search size={16} />}Wczytaj
        </button>
      </div>
      {loading && <p className="muted" role="status">Wczytuję podróż z Intercity… to potrwa kilkanaście sekund.</p>}
      {error && <p className="notice" role="alert">{error}</p>}

      {preview && connection && (
        <>
          <section className="journey-card" aria-label="Podgląd podróży">
            <strong>{preview.origin} → {preview.destination}</strong>
            <span>{formatDate(connection.date)} · {connection.departureTime} → {connection.arrivalTime}</span>
            <span>{connection.trainNumber}{connection.trainName ? ` ${connection.trainName}` : ''}</span>
            <small>{preview.passengers ?? 1}x pasażer{preview.ticketLabel ? ` · ${preview.ticketLabel}` : ''}</small>
            {preview.confidence === 'guess' && (
              <small className="warn">Nie mamy pewności, że to właściwy pociąg — wybierz z listy poniżej.</small>
            )}
          </section>
          <label>
            {preview.confidence === 'guess' ? 'Pociąg' : 'Zmień pociąg'}
            <select value={connection.connectionId} onChange={(event) => setConnectionId(Number(event.target.value))}>
              {preview.alternatives.map((item) => (
                <option key={item.connectionId} value={item.connectionId}>
                  {item.departureTime} → {item.arrivalTime} · {item.trainNumber}{item.trainName ? ` ${item.trainName}` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="grid-three">
            <label>Class
              <select value={travelClass} onChange={(event) => setTravelClass(Number(event.target.value))}>
                <option value={2}>2 klasa</option>
                <option value={1}>1 klasa</option>
              </select>
            </label>
            <label>Interval<input type="number" min={2} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label>
            <label className="check"><input type="checkbox" checked={seatRequired} onChange={(event) => setSeatRequired(event.target.checked)} />Seat required</label>
          </div>
          {classPrice && <small className="muted">Cena w klasie {travelClass}: {formatPrice(classPrice.price)}{classPrice.note ? ` — ${classPrice.note}` : ''}</small>}
          <label className="check"><input type="checkbox" checked={blik} onChange={(event) => { setBlik(event.target.checked); setConsent(false); }} />Przygotuj zakup z płatnością BLIK</label>
          {blik && <label className="check"><input type="checkbox" checked={consent} required onChange={(event) => setConsent(event.target.checked)} />Zgadzam się na zaznaczenie wymaganych regulaminów e-IC i Moje IC. Bez faktury i darowizny.</label>}
          <div className="form-actions">
            <button disabled={busy || saving} type="submit"><Check size={16} />Zatwierdź</button>
          </div>
        </>
      )}
    </form>
  );
}
