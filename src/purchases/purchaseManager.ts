import { PaymentNotSubmittedError, PurchasePreparationError, PurchaseError, codeDeadline, type PurchasePage, type PurchaseRecord, type PurchaseRepository, type PurchaseState } from './types.js';
import { recordCheckLog } from '../scheduler/checkLogger.js';

interface LivePurchase { record: PurchaseRecord; page: PurchasePage; operation: Promise<void> | null }

export class PurchaseManager {
  private live: LivePurchase | null = null;
  private checking = false;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly wakeups = new Set<() => void>();
  private preparation?: Promise<PurchaseRecord>;
  private shutdownTask?: Promise<void>;

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
      live = { record, page, operation: null };
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
      if (this.stopping || this.now() >= live.record.acceptCodeUntil) await this.defer(live);
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
    const live = this.live;
    const record = await this.repository.get(id);
    if (!record) throw new PurchaseError('Nie znaleziono sesji zakupu.', 404);
    if (record.attemptId === attemptId) return; // Same request must never repeat the payment.
    if (!live || live.record.id !== id || live.operation || this.stopping) {
      throw new PurchaseError('Sesja nie przyjmuje teraz kodu BLIK.');
    }
    // Set the operation before any awaited DB or browser work, excluding the timer.
    let claimed = false;
    const operation = (async () => {
      claimed = await this.repository.claimAttempt(id, attemptId, this.now());
      if (!claimed) return;
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
    })();
    live.operation = operation;
    try { await operation; } finally { if (live.operation === operation) live.operation = null; }
    if (!claimed) throw new PurchaseError('Upłynął termin podania kodu BLIK lub płatność już trwa.');
  }

  async tick(): Promise<void> {
    const live = this.live;
    if (!live || live.operation || live.record.state === 'PREPARING') return;
    const operation = this.inspect(live);
    live.operation = operation;
    try { await operation; }
    catch {
      if (this.now().getTime() >= live.record.expiresAt.getTime() + 2 * 60_000) {
        await this.finish(live, 'UNKNOWN', 'Nie można potwierdzić wyniku. Sprawdź zamówienie na koncie Intercity.');
      } else if (live.record.state === 'WAITING_FOR_BLIK' && this.now() >= live.record.acceptCodeUntil) {
        await this.defer(live).catch(() => this.finish(live, 'FAILED', 'Nie udało się potwierdzić odroczenia płatności.'));
      }
    } finally { if (live.operation === operation) live.operation = null; }
  }

  private async inspect(live: LivePurchase): Promise<void> {
    const observation = await live.page.observe();
    if (observation.expiresAt) {
      const expiresAt = new Date(Math.min(live.record.expiresAt.getTime(), observation.expiresAt.getTime()));
      live.record = await this.repository.update(live.record.id, {
        expiresAt, acceptCodeUntil: new Date(Math.min(live.record.acceptCodeUntil.getTime(), expiresAt.getTime() - 3 * 60_000)),
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
      await this.defer(live);
    } else if (this.now().getTime() >= live.record.expiresAt.getTime() + 2 * 60_000) {
      await this.finish(live, 'UNKNOWN', 'Brak potwierdzonego wyniku płatności. Sprawdź zamówienie na koncie Intercity.');
    }
  }

  private async defer(live: LivePurchase, unknownClock = false, failureReason?: string): Promise<void> {
    if (!unknownClock && this.now() >= live.record.expiresAt) {
      await this.finish(live, 'EXPIRED', 'Upłynął czas rezerwacji.');
      return;
    }
    const result = await live.page.defer();
    if (result.confirmed) {
      live.record = await this.repository.update(live.record.id, {
        intercityUrl: result.intercityUrl, orderNumber: result.orderNumber,
      });
      await this.finish(live, 'DEFERRED', failureReason ?? null);
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
    } else {
      await this.defer(live).catch(() => this.finish(live, 'UNKNOWN', 'Nie potwierdzono odroczenia przy wyłączeniu backendu.'));
    }
  }
}
