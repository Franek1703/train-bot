import { randomUUID } from 'node:crypto';
import { PaymentNotSubmittedError, PurchasePreparationError, PurchaseError, codeDeadline, type PurchasePage, type PurchaseRecord, type PurchaseRepository, type PurchaseState, type RemoteAction } from './types.js';
import { recordCheckLog } from '../scheduler/checkLogger.js';

interface LivePurchase { record: PurchaseRecord; page: PurchasePage; operation: Promise<void> | null; waitingOperations: number }

export class PurchaseManager {
  private live: LivePurchase | null = null;
  private checking = false;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly wakeups = new Set<() => void>();
  private preparation?: Promise<PurchaseRecord>;
  private shutdownTask?: Promise<void>;
  private control?: { purchaseId: string; token: string; expiresAt: number };
  private readonly remoteActions = new Set<string>();

  browserAvailable(id: string): boolean { return this.live?.record.id === id && !!this.live.page.remote && !this.stopping; }

  private async runOperation<T>(id: string, run: (live: LivePurchase) => Promise<T>, wait = false): Promise<T> {
    const live = this.live;
    if (!live || live.record.id !== id || this.stopping) throw new PurchaseError('Sesja przeglądarki bota nie jest już dostępna.', 410);
    if (!wait && (live.operation || live.waitingOperations)) throw new PurchaseError('Bot wykonuje czynność. Poczekaj chwilę.');
    if (wait) live.waitingOperations += 1;
    try {
      // Give user actions priority over polling, including frames from other devices.
      while (live.operation) await live.operation.catch(() => {});
      if (this.live !== live || this.stopping) throw new PurchaseError('Sesja przeglądarki bota nie jest już dostępna.', 410);
      let result!: T;
      const operation = Promise.resolve().then(async () => { result = await run(live); });
      live.operation = operation;
      try { await operation; return result; } finally { if (live.operation === operation) live.operation = null; }
    } finally { if (wait) live.waitingOperations -= 1; }
  }

  private ownsControl(id: string, token?: string): boolean {
    return !!token && this.control?.purchaseId === id && this.control.token === token && this.control.expiresAt > this.now().getTime();
  }

  acquireControl(id: string, takeover = false) {
    if (!this.browserAvailable(id)) throw new PurchaseError('Sesja przeglądarki bota nie jest już dostępna.', 410);
    if (this.live!.record.state === 'PAYMENT_PENDING') throw new PurchaseError('Trwa płatność. Dostępny jest tylko podgląd.');
    if (this.control && this.control.expiresAt > this.now().getTime() && !takeover) throw new PurchaseError('Inne urządzenie steruje stroną. Możesz przejąć sterowanie.');
    this.control = { purchaseId: id, token: randomUUID(), expiresAt: this.now().getTime() + 30_000 };
    return { token: this.control.token, expiresAt: new Date(this.control.expiresAt).toISOString() };
  }

  renewControl(id: string, token?: string) {
    if (!this.browserAvailable(id) || !this.ownsControl(id, token)) throw new PurchaseError('Sterowanie wygasło lub zostało przejęte przez inne urządzenie.');
    this.control!.expiresAt = this.now().getTime() + 30_000;
    return { expiresAt: new Date(this.control!.expiresAt).toISOString() };
  }

  releaseControl(id: string, token?: string): void { if (this.ownsControl(id, token)) this.control = undefined; }

  async remoteFrame(id: string, token?: string) {
    return this.runOperation(id, async (live) => {
      if (!live.page.remote) throw new PurchaseError('Podgląd tej sesji nie jest dostępny.', 410);
      return { frame: await live.page.remote.frame(), ownsControl: this.ownsControl(id, token),
        controlBusy: !!this.control && this.control.expiresAt > this.now().getTime(),
        canControl: ['WAITING_FOR_BLIK', 'WAITING_AFTER_DEFERRAL'].includes(live.record.state), state: live.record.state };
    });
  }

  async remoteAction(id: string, token: string | undefined, action: RemoteAction, attemptId: string): Promise<void> {
    if (!this.ownsControl(id, token)) throw new PurchaseError('Sterowanie wygasło lub zostało przejęte przez inne urządzenie.');
    if (this.remoteActions.has(attemptId)) return;
    await this.runOperation(id, async (live) => {
      if (!this.ownsControl(id, token)) throw new PurchaseError('Sterowanie wygasło lub zostało przejęte przez inne urządzenie.');
      if (this.remoteActions.has(attemptId)) return;
      if (!live.page.remote || !['WAITING_FOR_BLIK', 'WAITING_AFTER_DEFERRAL'].includes(live.record.state)) throw new PurchaseError('Strona przyjmuje teraz tylko podgląd.');
      if (this.now() >= live.record.acceptCodeUntil) {
        await this.inspect(live);
        throw new PurchaseError('Termin zmienił się. Odśwież widok strony.');
      }
      await live.page.remote.action(action, async (intent) => {
        if (intent === 'defer') await this.defer(live);
        else if (intent === 'submit') {
          if (live.record.state === 'WAITING_AFTER_DEFERRAL') {
            await this.resumeLive(live); // First click opens the existing deferred checkout.
          } else {
            const code = await live.page.readCode?.();
            if (!code || !/^\d{6}$/.test(code)) throw new PurchaseError('Wpisz sześciocyfrowy kod BLIK.', 400);
            await this.submitLive(live, code, attemptId);
          }
        }
      });
      this.remoteActions.add(attemptId);
      if (this.remoteActions.size > 100) this.remoteActions.delete(this.remoteActions.values().next().value!);
    }, true);
  }

  async resumeDeferred(id: string): Promise<void> {
    await this.runOperation(id, (live) => this.resumeLive(live), true);
  }

  private async resumeLive(live: LivePurchase): Promise<void> {
    if (live.record.state !== 'WAITING_AFTER_DEFERRAL' || !live.page.resumeDeferred) throw new PurchaseError('Brak odroczonego zamówienia do otwarcia.');
    if (this.now() >= live.record.acceptCodeUntil) throw new PurchaseError('Upłynął termin płatności odroczonego zamówienia.');
    const details = await live.page.resumeDeferred(live.record.orderNumber);
    const expiresAt = new Date(Math.min(live.record.expiresAt.getTime(), details.expiresAt?.getTime() ?? Infinity));
    live.record = await this.repository.update(live.record.id, { expiresAt, acceptCodeUntil: new Date(expiresAt.getTime() - 30_000), state: 'WAITING_FOR_BLIK' });
    live.page.remote?.invalidate();
  }

  constructor(
    private readonly repository: PurchaseRepository,
    private readonly notify: (session: PurchaseRecord) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  get busy(): boolean { return this.checking || this.live !== null || this.stopping; }

  // Every Intercity check shares this gate, including API requests and queued checks.
  async runCheck<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new PurchaseError('Konto Intercity jest zajęte sprawdzaniem lub płatnością.');
    this.checking = true;
    try { return await run(); } finally { this.checking = false; }
  }

  async prepare(watchId: string, seatAssignment: string, expiresAt: Date | undefined, page: PurchasePage): Promise<PurchaseRecord> {
    if (this.preparation) {
      await page.close().catch(() => {});
      throw new PurchaseError('Inna sesja zakupu jest przygotowywana.');
    }
    const task = this.prepareSession(watchId, seatAssignment, expiresAt, page);
    this.preparation = task;
    try { return await task; } finally { if (this.preparation === task) this.preparation = undefined; }
  }

  private async prepareSession(watchId: string, seatAssignment: string, expiresAt: Date | undefined, page: PurchasePage): Promise<PurchaseRecord> {
    if (this.live || this.stopping) {
      await page.close();
      throw new PurchaseError('Inna sesja zakupu jest aktywna.');
    }
    let live: LivePurchase | undefined;
    try {
      const initialExpiry = expiresAt ?? this.now();
      const record = await this.repository.create(watchId, seatAssignment, initialExpiry,
        expiresAt ? codeDeadline(expiresAt, this.now()) : this.now());
      live = { record, page, operation: null, waitingOperations: 0 };
      this.live = live;
      let details: Awaited<ReturnType<PurchasePage['prepare']>> | undefined;
      const preparation = (async () => { details = await page.prepare(); })();
      live.operation = preparation;
      try { await preparation; } finally { live.operation = null; }
      if (this.live !== live) return live.record;
      const prepared = details!;
      const shortenedExpiry = expiresAt ? new Date(Math.min(expiresAt.getTime(), prepared.expiresAt.getTime())) : prepared.expiresAt;
      live.record = await this.repository.update(record.id, {
        ...prepared, expiresAt: shortenedExpiry,
        acceptCodeUntil: new Date(Math.min(record.acceptCodeUntil.getTime(), codeDeadline(shortenedExpiry, this.now()).getTime())),
        state: 'WAITING_FOR_BLIK',
      });
      if (this.stopping || this.now() >= live.record.acceptCodeUntil) await this.defer(live, !expiresAt);
      else this.emit(live.record);
      this.startTimer();
      return live.record;
    } catch (error) {
      if (live) {
        const reason = error instanceof PurchasePreparationError ? error.message : 'Nie udało się przygotować strony płatności BLIK.';
        recordCheckLog('error', 'Purchase preparation failed', { purchaseId: live.record.id, reason });
        console.error(JSON.stringify({ level: 'error', message: 'Purchase preparation failed', purchaseId: live.record.id, reason }));
        try { await this.defer(live, !expiresAt, reason); }
        catch { await this.finish(live, 'FAILED', `${reason} Nie udało się odroczyć płatności.`); }
        return live.record;
      }
      await page.close().catch(() => {});
      throw new PurchaseError('Nie udało się utworzyć sesji zakupu.', 503);
    }
  }

  async submit(id: string, code: string, attemptId: string): Promise<void> {
    const record = await this.repository.get(id);
    if (!record) throw new PurchaseError('Nie znaleziono sesji zakupu.', 404);
    if (record.attemptId === attemptId) return; // Same request must never repeat the payment.
    await this.runOperation(id, async (live) => {
      if (live.record.attemptId === attemptId) return;
      if (live.record.state === 'WAITING_AFTER_DEFERRAL') await this.resumeLive(live);
      await this.submitLive(live, code, attemptId);
    }, true);
    code = '';
  }

  private async submitLive(live: LivePurchase, code: string, attemptId: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) throw new PurchaseError('Kod BLIK musi mieć 6 cyfr.', 400);
    const id = live.record.id;
    let claimed = false;
    live.page.remote?.invalidate();
    try {
      claimed = await this.repository.claimAttempt(id, attemptId, this.now());
      if (!claimed) throw new PurchaseError('Upłynął termin podania kodu BLIK lub płatność już trwa.');
      live.record = await this.repository.get(id) ?? live.record;
      try { await live.page.submit(code); }
      catch (error) {
        if (error instanceof PaymentNotSubmittedError) {
          live.record = await this.repository.update(id, { state: 'WAITING_FOR_BLIK', errorMessage: 'Dane płatności nie są zgodne z przygotowanym zakupem. Kod nie został wysłany.' });
          await this.defer(live).catch(() => this.finish(live, 'FAILED', 'Kod nie został wysłany; nie udało się potwierdzić odroczenia.'));
          return;
        }
        // A click may have reached the provider. Never infer rejection from a timeout.
        live.record = await this.repository.update(id, { errorMessage: 'Sprawdzamy wynik wysłanej płatności. Nie wysyłaj kodu ponownie.' });
      } finally { code = ''; }
    } finally { code = ''; }
  }

  async tick(): Promise<void> {
    const live = this.live;
    if (!live || live.operation || live.waitingOperations || live.record.state === 'PREPARING') return;
    const operation = this.inspect(live);
    live.operation = operation;
    try { await operation; }
    catch {
      if (this.now().getTime() >= live.record.expiresAt.getTime() + 2 * 60_000) {
        await this.finish(live, 'UNKNOWN', 'Nie można potwierdzić wyniku. Sprawdź zamówienie na koncie Intercity.');
      } else if (live.record.state === 'WAITING_FOR_BLIK' && !live.record.deferredAt && this.now() >= live.record.acceptCodeUntil) {
        await this.defer(live).catch(() => this.finish(live, 'FAILED', 'Nie udało się potwierdzić odroczenia płatności.'));
      }
    } finally { if (live.operation === operation) live.operation = null; }
  }

  private async inspect(live: LivePurchase): Promise<void> {
    if (live.record.state !== 'PAYMENT_PENDING' && this.now() >= live.record.expiresAt) {
      await this.finish(live, 'EXPIRED', 'Upłynął czas rezerwacji.');
      return;
    }
    const observation = await live.page.observe();
    if (observation.expiresAt) {
      const expiresAt = new Date(Math.min(live.record.expiresAt.getTime(), observation.expiresAt.getTime()));
      live.record = await this.repository.update(live.record.id, {
        expiresAt, acceptCodeUntil: new Date(Math.min(live.record.acceptCodeUntil.getTime(), expiresAt.getTime() - (live.record.deferredAt ? 30_000 : 3 * 60_000))),
      });
    }
    if (observation.outcome === 'paid') {
      live.record = await this.repository.update(live.record.id, {
        orderNumber: observation.orderNumber, intercityUrl: observation.intercityUrl,
      });
      await this.finish(live, 'PAID');
      return;
    }
    if (observation.outcome === 'expired') {
      await this.finish(live, live.record.state === 'PAYMENT_PENDING' ? 'UNKNOWN' : 'EXPIRED',
        'Rezerwacja wygasła. Sprawdź stan zamówienia na koncie Intercity.');
      return;
    }
    if (observation.outcome === 'rejected' && live.record.state === 'PAYMENT_PENDING') {
      live.record = await this.repository.update(live.record.id, {
        state: 'WAITING_FOR_BLIK', errorMessage: 'Płatność została odrzucona. Możesz podać nowy kod BLIK.',
      });
    }
    if (live.record.state === 'WAITING_FOR_BLIK' && this.now() >= live.record.acceptCodeUntil) {
      if (!live.record.deferredAt) await this.defer(live);
      else if (this.now() >= live.record.expiresAt) await this.finish(live, 'EXPIRED', 'Upłynął termin płatności odroczonego zamówienia.');
    } else if (live.record.state === 'WAITING_AFTER_DEFERRAL' && this.now() >= live.record.expiresAt) {
      await this.finish(live, 'EXPIRED', 'Upłynął termin płatności odroczonego zamówienia.');
    } else if (this.now().getTime() >= live.record.expiresAt.getTime() + 2 * 60_000) {
      await this.finish(live, 'UNKNOWN', 'Brak potwierdzonego wyniku płatności. Sprawdź zamówienie na koncie Intercity.');
    }
  }

  private async defer(live: LivePurchase, unknownClock = false, failureReason?: string): Promise<void> {
    if (live.record.deferredAt) throw new PurchaseError('To zamówienie zostało już odroczone.');
    if (!unknownClock && this.now() >= live.record.expiresAt) {
      await this.finish(live, 'EXPIRED', 'Upłynął czas rezerwacji.');
      return;
    }
    const result = await live.page.defer();
    if (result.confirmed) {
      const expiresAt = result.expiresAt ?? live.record.expiresAt;
      live.record = await this.repository.update(live.record.id, {
        intercityUrl: result.intercityUrl, orderNumber: result.orderNumber,
        deferredAt: this.now(), expiresAt, acceptCodeUntil: new Date(expiresAt.getTime() - 30_000),
      });
      if (this.stopping || failureReason || unknownClock) await this.finish(live, 'DEFERRED', failureReason ?? null);
      else if (expiresAt <= this.now()) await this.finish(live, 'EXPIRED', 'Upłynął czas rezerwacji.');
      else {
        live.record = await this.repository.update(live.record.id, { state: 'WAITING_AFTER_DEFERRAL', errorMessage: null });
        this.emit(live.record);
      }
    } else {
      await this.finish(live, 'FAILED', [failureReason, 'Intercity nie potwierdziło opcji „Zapłać później”.'].filter(Boolean).join(' '));
    }
  }

  private async finish(live: LivePurchase, state: PurchaseState, errorMessage: string | null = null): Promise<void> {
    // Persist first. A DB outage keeps the gate closed instead of allowing a duplicate checkout.
    live.record = await this.repository.update(live.record.id, { state, errorMessage });
    try { await live.page.close().catch(() => console.error('Could not close completed purchase browser')); }
    finally {
      if (this.live === live) this.live = null;
      this.control = undefined;
      this.remoteActions.clear();
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.emit(live.record);
      for (const wake of this.wakeups) wake();
    }
  }

  private emit(record: PurchaseRecord): void {
    try { this.notify(record); } catch { console.error('Purchase notification failed'); }
  }

  waitForNextCheck(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); this.wakeups.delete(wake); resolve(); };
      const timer = setTimeout(wake, timeoutMs);
      this.wakeups.add(wake);
    });
  }

  private startTimer(): void {
    if (!this.live || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => console.error('Purchase session update failed')); }, 1_000);
    this.timer.unref();
  }

  shutdown(): Promise<void> {
    this.shutdownTask ??= this.doShutdown().catch(async () => {
      // Leave the persisted active state for startup recovery if the DB is down.
      console.error('Could not persist purchase shutdown; startup recovery is required');
      await this.live?.page.close().catch(() => console.error('Could not close purchase browser during shutdown'));
      this.live = null;
    });
    return this.shutdownTask;
  }

  private async doShutdown(): Promise<void> {
    this.stopping = true;
    for (const wake of this.wakeups) wake();
    if (this.timer) clearInterval(this.timer);
    await this.preparation?.catch(() => {});
    const live = this.live;
    if (!live) return;
    await live.operation?.catch(() => {});
    if (live.record.state === 'PAYMENT_PENDING') {
      await this.finish(live, 'UNKNOWN', 'Backend został wyłączony podczas płatności. Sprawdź zamówienie na koncie Intercity.');
    } else if (live.record.deferredAt) {
      await this.finish(live, 'UNKNOWN', 'Sesja odroczonego zamówienia została zamknięta.');
    } else {
      await this.defer(live).catch(() => this.finish(live, 'UNKNOWN', 'Nie potwierdzono odroczenia przy wyłączeniu backendu.'));
    }
  }
}
