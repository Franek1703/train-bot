import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiGet, browserRequest, newAttemptId, type BrowserFrame, type PurchaseSession, type RemoteTarget, type Watch } from './api';
import { PurchasePanel } from './PurchasePanel';

export function RemotePurchaseView({ watchId }: { watchId: string }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [purchase, setPurchase] = useState<PurchaseSession | null>(null);
  const [error, setError] = useState('');
  const onAccountState = useCallback(() => {}, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [details, payment] = await Promise.all([
          apiGet<{ watch: Watch }>(`/watches/${watchId}`),
          apiGet<{ purchase: PurchaseSession | null }>(`/watches/${watchId}/purchase`),
        ]);
        if (!cancelled) { setWatch(details.watch); setPurchase(payment.purchase); setError(''); }
      } catch { if (!cancelled) setError('Nie można odczytać sesji zakupu.'); }
      finally { if (!cancelled) timer = setTimeout(() => void poll(), 2_000); }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watchId]);
  return <main className="remote-view">
    <a href={`/?watch=${watchId}`}>Wróć do dashboardu</a>
    <h1>Intercity — strona bota</h1>
    {error && <p role="alert">{error}</p>}
    {watch && <p>{watch.trainNumber} · {watch.origin} → {watch.destination}</p>}
    {purchase?.browserAvailable ? <RemoteBrowser key={purchase.id} purchaseId={purchase.id} />
      : <p role="status">{purchase ? 'Sesja przeglądarki bota nie jest już dostępna.' : 'Oczekiwanie na sesję zakupu.'}</p>}
    {watch && <PurchasePanel watch={watch} onAccountState={onAccountState} />}
  </main>;
}

export function RemoteBrowser({ purchaseId }: { purchaseId: string }) {
  const [view, setView] = useState<BrowserFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [field, setField] = useState<RemoteTarget | null>(null);
  const [value, setValue] = useState('');
  const [zoom, setZoom] = useState(() => window.innerWidth <= 700 ? 200 : 100);
  const token = useRef<string | undefined>(undefined);
  const latest = useRef<BrowserFrame | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const touchY = useRef<number | null>(null);
  const pendingFrame = useRef<Promise<BrowserFrame> | null>(null);

  const refresh = useCallback(async () => {
    const request = browserRequest<BrowserFrame>(purchaseId, 'frame', 'GET', token.current);
    pendingFrame.current = request;
    let result: BrowserFrame;
    try { result = await request; } finally { if (pendingFrame.current === request) pendingFrame.current = null; }
    if (!mounted.current) return;
    latest.current = result;
    setView(result);
    setConnected(true);
    if (token.current && !result.ownsControl) { token.current = undefined; setField(null); setValue(''); }
  }, [purchaseId]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled) return;
      if (!operation.current && document.visibilityState === 'visible') {
        try { await refresh(); }
        catch (error) {
          if (!cancelled) {
            setConnected(false);
            if (error instanceof ApiError && error.status === 410) { setNotice(error.message); cancelled = true; }
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1_000);
    }
    void poll();
    const heartbeat = setInterval(() => {
      if (!token.current || document.visibilityState !== 'visible') return;
      void browserRequest(purchaseId, 'control', 'PATCH', token.current).catch(() => {
        if (mounted.current) { token.current = undefined; setConnected(false); setField(null); setValue(''); }
      });
    }, 10_000);
    return () => {
      mounted.current = false; cancelled = true; clearTimeout(timer); clearInterval(heartbeat);
      const previous = token.current; token.current = undefined;
      if (previous) void browserRequest(purchaseId, 'control', 'DELETE', previous).catch(() => {});
    };
  }, [purchaseId, refresh]);

  const canControl = connected && !!view?.ownsControl && view.canControl && !busy;

  async function acquire() {
    if (operation.current) return;
    operation.current = true; setBusy(true);
    try {
      await pendingFrame.current?.catch(() => {});
      const result = await browserRequest<{ token: string }>(purchaseId, 'control', 'POST', undefined, { takeover: view?.controlBusy ?? false });
      token.current = result.token;
      setNotice(''); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Nie można przejąć sterowania.'); }
    finally { operation.current = false; setBusy(false); }
  }

  async function act(action: object, frameId = view?.frame.id) {
    const current = latest.current;
    if (!current || !canControl || operation.current) return;
    operation.current = true; setBusy(true); setNotice('');
    try {
      await pendingFrame.current?.catch(() => {});
      await browserRequest(purchaseId, 'action', 'POST', token.current, { ...action, frameId, attemptId: newAttemptId() });
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Czynność nie została wykonana.');
      setConnected(false);
    } finally { operation.current = false; setBusy(false); }
  }

  function selectTarget(target: RemoteTarget) {
    if (target.kind === 'click') void act({ kind: 'click', targetId: target.id });
    else { setField(target); setValue(''); }
  }

  async function fillField(event: React.FormEvent) {
    event.preventDefault();
    const target = latest.current?.frame.targets.find((item) => item.kind === field?.kind && item.label === field.label
      && Math.abs(item.x - field.x) < 2 && Math.abs(item.y - field.y) < 2);
    if (!target) { setNotice('Pole zmieniło położenie. Wybierz je ponownie.'); setField(null); setValue(''); return; }
    const text = value;
    setValue(''); setField(null);
    await act(target.kind === 'select' ? { kind: 'select', targetId: target.id, value: text } : { kind: 'fill', targetId: target.id, text }, latest.current?.frame.id);
  }

  return <section className="remote-browser" aria-label="Zdalna strona Intercity">
    <div className="actions">
      <label>Powiększenie obrazu <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
        <option value={100}>100%</option><option value={200}>200%</option><option value={300}>300%</option>
      </select></label>
      {!view?.ownsControl && <button onClick={() => void acquire()} disabled={busy || !connected || !view?.canControl}>
        {view?.controlBusy ? 'Przejmij sterowanie' : 'Włącz sterowanie'}
      </button>}
      {view?.ownsControl && <button onClick={() => {
        const previous = token.current; token.current = undefined; setConnected(false); setField(null); setValue('');
        void browserRequest(purchaseId, 'control', 'DELETE', previous).catch(() => {});
      }}>Zwolnij sterowanie</button>}
      <button disabled={!canControl} onClick={() => void act({ kind: 'scroll', deltaY: -500 })}>Przewiń w górę</button>
      <button disabled={!canControl} onClick={() => void act({ kind: 'scroll', deltaY: 500 })}>Przewiń w dół</button>
      <button disabled={!canControl} onClick={() => void act({ kind: 'key', key: 'Tab' })}>Tab</button>
      <button disabled={!canControl} onClick={() => void act({ kind: 'key', key: 'Enter' })}>Enter</button>
    </div>
    <p role="status">{!connected ? 'Odświeżamy połączenie ze stroną bota.' : view?.ownsControl && view.canControl
      ? 'Sterujesz stroną bota. Kliknij element obrazu, aby go obsłużyć.' : 'Podgląd strony bota.'}</p>
    {notice && <p role="alert">{notice}</p>}
    {field && <form className="remote-field" onSubmit={(event) => void fillField(event)}>
      <label htmlFor="remote-field">{field.label}</label>
      {field.kind === 'select' ? <select id="remote-field" value={value} onChange={(event) => setValue(event.target.value)} disabled={!canControl}>
        <option value="" disabled>Wybierz opcję</option>
        {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input id="remote-field" aria-label="Wpisz wartość pola" type={field.sensitive ? 'password' : 'text'}
        inputMode={/blik|blick/i.test(field.label) ? 'numeric' : 'text'} autoComplete="off" value={value}
        onChange={(event) => setValue(event.target.value.slice(0, 2_000))} disabled={!canControl} />}
      <button type="submit" disabled={!canControl}>Wpisz na stronie bota</button>
      <button type="button" onClick={() => { setField(null); setValue(''); }}>Zamknij pole</button>
    </form>}
    {view && <div className="remote-screen-scroll"><div className="remote-screen" style={{ width: `${zoom}%`, aspectRatio: `${view.frame.width} / ${view.frame.height}` }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
      onTouchEnd={(event) => {
        const y = event.changedTouches[0]?.clientY;
        if (touchY.current !== null && y !== undefined && Math.abs(touchY.current - y) > 30) {
          void act({ kind: 'scroll', deltaY: Math.max(-1_000, Math.min(1_000, (touchY.current - y) * 2)) });
        }
        touchY.current = null;
      }}>
      <img src={view.frame.image} alt="Aktualna strona Intercity otwarta w bocie" draggable={false} />
      {view.frame.targets.map((target) => <button key={target.id} className="remote-target" aria-label={`Element strony: ${target.label}`}
        disabled={!canControl} onClick={() => selectTarget(target)}
        style={{ left: `${target.x / view.frame.width * 100}%`, top: `${target.y / view.frame.height * 100}%`,
          width: `${target.width / view.frame.width * 100}%`, height: `${target.height / view.frame.height * 100}%` }} />)}
    </div></div>}
  </section>;
}
