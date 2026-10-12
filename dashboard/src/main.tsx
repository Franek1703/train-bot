import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  apiGet,
  apiSend,
  artifactUrl,
  type Watch,
  type WatchDetails,
  type WatchError,
  type WatchInput,
} from './api';
import './styles.css';
import { PurchasePanel } from './PurchasePanel';
import { RemotePurchaseView } from './RemoteBrowser';
import type { PurchaseSession } from './api';

type View = 'watches' | 'errors';

const emptyForm: WatchInput = {
  searchUrl: '',
  origin: '',
  destination: '',
  date: new Date().toISOString().slice(0, 10),
  trainNumber: '',
  departureTime: '',
  travelClass: 2,
  passengers: 1,
  seatRequired: true,
  intervalMinutes: 5,
  active: true,
  notificationTarget: '',
  purchaseMode: 'notify',
  purchaseConsent: false,
};

function App() {
  const [view, setView] = useState<View>('watches');
  const [watches, setWatches] = useState<Watch[]>([]);
  const [errors, setErrors] = useState<WatchError[]>([]);
  const [selectedWatchId, setSelectedWatchId] = useState<string | undefined>(() => new URL(window.location.href).searchParams.get('watch') ?? undefined);
  const [selectedWatch, setSelectedWatch] = useState<WatchDetails>();
  const [form, setForm] = useState<WatchInput>(emptyForm);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [account, setAccount] = useState<{ busy: boolean; state?: PurchaseSession['state'] }>({ busy: false });
  const onAccountState = useCallback((accountBusy: boolean, state?: PurchaseSession['state']) => {
    setAccount((current) => current.busy === accountBusy && current.state === state ? current : { busy: accountBusy, state });
  }, []);

  const selectedListWatch = useMemo(
    () => watches.find((watch) => watch.id === selectedWatchId),
    [selectedWatchId, watches],
  );

  useEffect(() => {
    void refresh().catch(() => setNotice('Nie udało się odświeżyć watcherów.'));
    const interval = setInterval(() => { void refresh().catch(() => setNotice('Nie udało się odświeżyć watcherów.')); }, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedWatchId) {
      setSelectedWatch(undefined);
      return;
    }

    void apiGet<{ watch: WatchDetails }>(`/watches/${selectedWatchId}`)
      .then(({ watch }) => { if (!cancelled) setSelectedWatch(watch); })
      .catch((error) => { if (!cancelled) setNotice(error.message); });
    return () => { cancelled = true; };
  }, [selectedWatchId]);

  async function refresh() {
    const [{ watches: nextWatches }, { errors: nextErrors }] = await Promise.all([
      apiGet<{ watches: Watch[] }>('/watches'),
      apiGet<{ errors: WatchError[] }>('/errors'),
    ]);
    setWatches(nextWatches);
    setErrors(nextErrors);
    setSelectedWatchId((current) => current ?? nextWatches[0]?.id);
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice('');

    try {
      const payload = normalizeForm(form);
      if (editingId) {
        await apiSend(`/watches/${editingId}`, 'PATCH', payload);
        setNotice('Watcher updated.');
      } else {
        await apiSend('/watches', 'POST', payload);
        setNotice('Watcher added.');
      }

      setForm(emptyForm);
      setEditingId(undefined);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, message: string) {
    let body: { acknowledgeUnknown: boolean } | undefined;
    if (path.endsWith('/resume') && account.state === 'UNKNOWN') {
      if (!window.confirm('Sprawdź zamówienie na koncie Intercity przed nową próbą zakupu. Czy sprawdziłeś wynik i chcesz wznowić monitorowanie?')) return;
      body = { acknowledgeUnknown: true };
    }
    setBusy(true);
    setNotice('');
    try {
      await apiSend(path, 'POST', body);
      setNotice(message);
      await refresh();
      if (selectedWatchId) {
        const { watch } = await apiGet<{ watch: WatchDetails }>(`/watches/${selectedWatchId}`);
        setSelectedWatch(watch);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeWatch(watchId: string) {
    setBusy(true);
    try {
      await apiSend(`/watches/${watchId}`, 'DELETE');
      setSelectedWatchId(undefined);
      setNotice('Watcher removed.');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function editWatch(watch: Watch) {
    setEditingId(watch.id);
    setForm({
      searchUrl: watch.journeyUrl ?? '',
      origin: watch.origin,
      destination: watch.destination,
      date: watch.travelDate.slice(0, 10),
      trainNumber: watch.trainNumber ?? '',
      departureTime: watch.departureTime ?? '',
      travelClass: watch.travelClass,
      passengers: watch.passengers,
      seatRequired: watch.seatRequired,
      intervalMinutes: watch.checkIntervalMinutes,
      active: watch.active,
      notificationTarget: '',
      purchaseMode: watch.purchaseMode,
      purchaseConsent: watch.purchaseConsent,
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <h1>Train Bot</h1>
          <p>{watches.length} watchers</p>
        </div>
        <button className={view === 'watches' ? 'active' : ''} onClick={() => setView('watches')}>
          Watchers
        </button>
        <button className={view === 'errors' ? 'active' : ''} onClick={() => setView('errors')}>
          Errors
        </button>
      </aside>

      <main>
        <header className="toolbar">
          <div>
            <h2>{view === 'watches' ? 'Watcher Management' : 'Error Center'}</h2>
            {notice && <p className="notice">{notice}</p>}
          </div>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </header>

        {view === 'watches' ? (
          <div className="workbench">
            <section className="panel">
              <form onSubmit={(event) => void submitForm(event)} className="watch-form">
                <h3>{editingId ? 'Edit watcher' : 'Add watcher'}</h3>
                <input placeholder="Search URL" value={form.searchUrl} onChange={(event) => setForm({ ...form, searchUrl: event.target.value })} required />
                <div className="grid-two">
                  <input placeholder="Origin" value={form.origin} onChange={(event) => setForm({ ...form, origin: event.target.value })} required />
                  <input placeholder="Destination" value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })} required />
                </div>
                <div className="grid-three">
                  <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
                  <input placeholder="Train" value={form.trainNumber} onChange={(event) => setForm({ ...form, trainNumber: event.target.value })} />
                  <input type="time" value={form.departureTime} onChange={(event) => setForm({ ...form, departureTime: event.target.value })} />
                </div>
                <div className="grid-four">
                  <label>Class<input type="number" min={1} max={2} value={form.travelClass} onChange={(event) => setForm({ ...form, travelClass: Number(event.target.value) })} /></label>
                  <label>Passengers<input type="number" min={1} max={9} value={form.passengers} onChange={(event) => setForm({ ...form, passengers: Number(event.target.value) })} /></label>
                  <label>Interval<input type="number" min={2} value={form.intervalMinutes} onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })} /></label>
                  <label className="check"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Active</label>
                </div>
                <label className="check"><input type="checkbox" checked={form.seatRequired} onChange={(event) => setForm({ ...form, seatRequired: event.target.checked })} />Seat required</label>
                <label className="check"><input type="checkbox" checked={form.purchaseMode === 'blik'} onChange={(event) => setForm({ ...form, purchaseMode: event.target.checked ? 'blik' : 'notify', purchaseConsent: false })} />Przygotuj zakup z płatnością BLIK</label>
                {form.purchaseMode === 'blik' && <>
                  <p className="muted">Dane podróżnego z konta Intercity. Po znalezieniu miejsca wpiszesz kod BLIK tutaj i potwierdzisz płatność w banku.</p>
                  <label className="check"><input type="checkbox" checked={form.purchaseConsent} required onChange={(event) => setForm({ ...form, purchaseConsent: event.target.checked })} />Zgadzam się na zaznaczenie wymaganych regulaminów e-IC i Moje IC. Bez faktury i darowizny.</label>
                </>}
                <div className="form-actions">
                  <button disabled={busy} type="submit"><Plus size={16} />{editingId ? 'Save' : 'Add'}</button>
                  {editingId && <button type="button" onClick={() => { setEditingId(undefined); setForm(emptyForm); }}>Cancel</button>}
                </div>
              </form>
            </section>

            <section className="panel list-panel">
              {watches.map((watch) => (
                <button key={watch.id} className={`watch-row ${selectedWatchId === watch.id ? 'selected' : ''}`} onClick={() => setSelectedWatchId(watch.id)}>
                  <span>{watch.trainNumber ?? 'Train'} {watch.departureTime ?? ''}</span>
                  <small>{watch.origin} to {watch.destination}</small>
                  <strong className={watch.active ? 'ok' : 'muted'}>{watch.active ? 'Active' : 'Stopped'} · {watch.lastKnownStatus ?? 'New'}</strong>
                </button>
              ))}
            </section>

            <section className="panel detail-panel">
              {selectedListWatch && (
                <>
                  <div className="detail-header">
                    <div>
                      <h3>{selectedListWatch.trainNumber ?? 'Watcher'}</h3>
                      <p>{selectedListWatch.origin} to {selectedListWatch.destination}</p>
                    </div>
                    <div className="actions">
                      <button title="Edit" disabled={account.busy} onClick={() => editWatch(selectedListWatch)}>Edit</button>
                      <button title="Check now" disabled={account.busy || account.state === 'UNKNOWN'} onClick={() => void action(`/watches/${selectedListWatch.id}/check-now`, 'Manual check finished.')}><RefreshCw size={16} /></button>
                      {selectedListWatch.active ? (
                        <button title="Stop" onClick={() => void action(`/watches/${selectedListWatch.id}/stop`, 'Watcher stopped.')}><Pause size={16} /></button>
                      ) : (
                        <button title="Resume" disabled={account.busy} onClick={() => void action(`/watches/${selectedListWatch.id}/resume`, 'Watcher resumed.')}><Play size={16} /></button>
                      )}
                      <button title="Delete" disabled={account.busy} onClick={() => void removeWatch(selectedListWatch.id)}><Trash2 size={16} /></button>
                    </div>
                  </div>
                  <PurchasePanel key={selectedListWatch.id} watch={selectedListWatch} onAccountState={onAccountState} />
                  <History watch={selectedWatch} />
                </>
              )}
            </section>
          </div>
        ) : (
          <Errors errors={errors} />
        )}
      </main>
    </div>
  );
}

function History({ watch }: { watch?: WatchDetails }) {
  if (!watch) return <p className="muted">Select a watcher.</p>;

  return (
    <div className="history">
      <h4>Recent checks</h4>
      {watch.availabilityChecks.map((check) => (
        <div className="history-row" key={check.id}>
          <span>{new Date(check.checkedAt).toLocaleString()}</span>
          <strong>{check.status}</strong>
          <small>{check.errorMessage ?? `${check.durationMs ?? 0} ms`}</small>
        </div>
      ))}
      <h4>Artifacts</h4>
      {watch.artifacts.map((artifact) => (
        <a key={artifact.id} href={artifactUrl(artifact.id)} target="_blank" rel="noreferrer">
          {artifact.kind}: {artifact.label ?? artifact.id}
        </a>
      ))}
    </div>
  );
}

function Errors({ errors }: { errors: WatchError[] }) {
  return (
    <section className="panel errors-panel">
      {errors.map((error) => (
        <article key={error.id} className="error-row">
          <AlertTriangle size={18} />
          <div>
            <strong>{error.watch?.trainNumber ?? error.watchId} · {error.status}</strong>
            <p>{error.message}</p>
            <small>{new Date(error.createdAt).toLocaleString()}</small>
            <div className="artifact-links">
              {error.screenshotArtifactId && <a href={artifactUrl(error.screenshotArtifactId)} target="_blank" rel="noreferrer">Screenshot</a>}
              {error.logArtifactId && <a href={artifactUrl(error.logArtifactId)} target="_blank" rel="noreferrer">Log</a>}
              {error.diagnosticArtifactId && <a href={artifactUrl(error.diagnosticArtifactId)} target="_blank" rel="noreferrer">Diagnostic</a>}
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function normalizeForm(form: WatchInput): WatchInput {
  return {
    ...form,
    trainNumber: form.trainNumber || undefined,
    departureTime: form.departureTime || undefined,
    notificationTarget: form.notificationTarget || undefined,
  };
}

const locationParams = new URL(window.location.href).searchParams;
const remoteWatch = locationParams.get('view') === 'intercity' ? locationParams.get('watch') : null;
createRoot(document.getElementById('root')!).render(remoteWatch ? <RemotePurchaseView watchId={remoteWatch} /> : <App />);
