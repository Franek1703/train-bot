import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseManager } from '../src/purchases/purchaseManager.js';
import { PaymentNotSubmittedError, codeDeadline, type PurchasePage, type PurchaseRecord, type PurchaseRepository } from '../src/purchases/types.js';

const start = new Date('2026-10-09T12:00:00Z');
const expiresAt = new Date(start.getTime() + 15 * 60_000);
const managers: PurchaseManager[] = [];

function harness(options: { expiry?: Date; notify?: (record: PurchaseRecord) => void } = {}) {
  let record: PurchaseRecord;
  const expiry = options.expiry ?? expiresAt;
  const repository: PurchaseRepository = {
    create: vi.fn(async (watchId, seatAssignment, expires, acceptCodeUntil) => {
      record = {
        id: 'purchase-1', watchId, availabilityCheckId: null, state: 'PREPARING',
        passengerName: null, seatAssignment, price: null, expiresAt: expires, acceptCodeUntil,
        attemptId: null, orderNumber: null, intercityUrl: null, errorMessage: null,
        createdAt: new Date(), updatedAt: new Date(),
      };
      return { ...record };
    }),
    get: vi.fn(async (id) => id === record?.id ? { ...record } : null),
    update: vi.fn(async (_id, patch) => { record = { ...record, ...patch }; return { ...record }; }),
    claimAttempt: vi.fn(async (_id, attemptId, now) => {
      if (record.state !== 'WAITING_FOR_BLIK' || record.acceptCodeUntil <= now) return false;
      record = { ...record, state: 'PAYMENT_PENDING', attemptId, errorMessage: null };
      return true;
    }),
  };
  const page = {
    prepare: vi.fn(async () => ({ passengerName: 'Test Passenger', price: '33,81 zł', intercityUrl: 'https://ebilet.intercity.pl/platnosc', expiresAt: expiry })),
    submit: vi.fn(async (_code: string) => {}),
    observe: vi.fn<PurchasePage['observe']>().mockResolvedValue({ outcome: 'pending' }),
    defer: vi.fn<PurchasePage['defer']>().mockResolvedValue({ confirmed: true, orderNumber: 'ORDER-1' }),
    close: vi.fn(async () => {}),
  } satisfies PurchasePage;
  const notify = options.notify ?? vi.fn();
  const manager = new PurchaseManager(repository, notify);
  managers.push(manager);
  return { manager, repository, page, notify, record: () => record };
}

describe('BLIK purchase lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    vi.useRealTimers();
  });

  it('retains the browser, publishes details and closes only after confirmed purchase', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'Wagon 9, miejsce 17', expiresAt, h.page);
    expect(h.record()).toMatchObject({ state: 'WAITING_FOR_BLIK', passengerName: 'Test Passenger', price: '33,81 zł' });
    expect(h.page.close).not.toHaveBeenCalled();
    expect(h.manager.busy).toBe(true);
    await h.manager.submit('purchase-1', '012345', 'attempt-1');
    expect(h.page.submit).toHaveBeenCalledWith('012345');
    expect(h.record().state).toBe('PAYMENT_PENDING');
    h.page.observe.mockResolvedValue({ outcome: 'paid', orderNumber: '123' });
    await h.manager.tick();
    expect(h.record()).toMatchObject({ state: 'PAID', orderNumber: '123' });
    expect(h.page.close).toHaveBeenCalledOnce();
    expect(h.manager.busy).toBe(false);
  });

  it('uses the reservation clock, including time spent before the dashboard email', async () => {
    vi.setSystemTime(new Date(start.getTime() + 4 * 60_000));
    const h = harness();
    const record = await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    expect(record.acceptCodeUntil).toEqual(new Date(start.getTime() + 12 * 60_000));
    expect(codeDeadline(new Date(start.getTime() + 8 * 60_000), start)).toEqual(new Date(start.getTime() + 5 * 60_000));
  });

  it('automatically defers at 12 minutes and rejects late codes', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    vi.setSystemTime(new Date(start.getTime() + 12 * 60_000));
    await expect(h.manager.submit('purchase-1', '123456', 'late')).rejects.toThrow('termin');
    await h.manager.tick();
    expect(h.page.defer).toHaveBeenCalledOnce();
    expect(h.record().state).toBe('DEFERRED');
    expect(h.page.submit).not.toHaveBeenCalled();
  });

  it('shortens the deadline when Intercity shortens its clock', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    h.page.observe.mockResolvedValue({ outcome: 'pending', expiresAt: new Date(start.getTime() + 5 * 60_000) });
    await h.manager.tick();
    expect(h.record().acceptCodeUntil).toEqual(new Date(start.getTime() + 2 * 60_000));
    h.page.observe.mockResolvedValue({ outcome: 'pending', expiresAt: new Date(start.getTime() + 30 * 60_000) });
    await h.manager.tick();
    expect(h.record().acceptCodeUntil).toEqual(new Date(start.getTime() + 2 * 60_000));
  });

  it('does not extend an unreadable reservation clock; it immediately attempts deferral', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', undefined, h.page);
    expect(h.page.defer).toHaveBeenCalledOnce();
    expect(h.record().state).toBe('DEFERRED');
    expect(h.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'WAITING_FOR_BLIK' }));
  });

  it('allows a fresh code only after an explicit rejection and before the deadline', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    await expect(h.manager.submit('purchase-1', '654321', 'attempt-2')).rejects.toThrow();
    h.page.observe.mockResolvedValue({ outcome: 'rejected' });
    await h.manager.tick();
    expect(h.record().state).toBe('WAITING_FOR_BLIK');
    await h.manager.submit('purchase-1', '654321', 'attempt-2');
    expect(h.page.submit).toHaveBeenCalledTimes(2);
  });

  it('does not repeat requests using the same attempt identifier', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    expect(h.page.submit).toHaveBeenCalledOnce();
    expect(h.repository.claimAttempt).toHaveBeenCalledOnce();
  });

  it('serializes concurrent submissions', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    const results = await Promise.allSettled([
      h.manager.submit('purchase-1', '123456', 'attempt-1'),
      h.manager.submit('purchase-1', '654321', 'attempt-2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.page.submit).toHaveBeenCalledOnce();
  });

  it('never defers an in-flight payment at the code deadline', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    vi.setSystemTime(new Date(start.getTime() + 12 * 60_000));
    await h.manager.tick();
    expect(h.page.defer).not.toHaveBeenCalled();
    expect(h.record().state).toBe('PAYMENT_PENDING');
    vi.setSystemTime(new Date(start.getTime() + 17 * 60_000));
    await h.manager.tick();
    expect(h.record().state).toBe('UNKNOWN');
  });

  it('does not race the timer against a browser submission already claimed before the deadline', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    let release!: () => void;
    h.page.submit.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const submitting = h.manager.submit('purchase-1', '123456', 'attempt-1');
    await vi.waitFor(() => expect(h.page.submit).toHaveBeenCalledOnce());
    vi.setSystemTime(new Date(start.getTime() + 12 * 60_000));
    await h.manager.tick();
    expect(h.page.defer).not.toHaveBeenCalled();
    release();
    await submitting;
    expect(h.record().state).toBe('PAYMENT_PENDING');
  });

  it('defers instead of charging when pre-submission verification proves checkout details changed', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    h.page.submit.mockRejectedValue(new PaymentNotSubmittedError('Changed amount'));
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    expect(h.record().state).toBe('DEFERRED');
    expect(h.page.defer).toHaveBeenCalledOnce();
    expect(h.page.close).toHaveBeenCalledOnce();
  });

  it('excludes submission errors containing a BLIK code from saved records and notifications', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    h.page.submit.mockRejectedValue(new Error('Playwright fill value 012345 timed out'));
    await h.manager.submit('purchase-1', '012345', 'attempt-1');
    expect(h.record().state).toBe('PAYMENT_PENDING');
    expect(JSON.stringify(h.record())).not.toContain('012345');
    expect(JSON.stringify((h.repository.update as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('012345');
  });

  it('does not report deferral when Intercity does not confirm it', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    h.page.defer.mockResolvedValue({ confirmed: false });
    vi.setSystemTime(new Date(start.getTime() + 12 * 60_000));
    await h.manager.tick();
    expect(h.record().state).toBe('FAILED');
    expect(h.page.close).toHaveBeenCalledOnce();
  });

  it('records expiry without trying to click an expired reservation', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    vi.setSystemTime(expiresAt);
    await h.manager.tick();
    expect(h.record().state).toBe('EXPIRED');
    expect(h.page.defer).not.toHaveBeenCalled();
  });

  it('keeps the live session when notifications throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ notify: () => { throw new Error('Email failed'); } });
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    expect(h.record().state).toBe('WAITING_FOR_BLIK');
    expect(h.page.close).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('blocks other checks until the session finishes and wakes the scheduler', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    const check = vi.fn();
    await expect(h.manager.runCheck(check)).rejects.toThrow('zajęte');
    expect(check).not.toHaveBeenCalled();
    let woken = false;
    const wake = h.manager.waitForNextCheck(300_000).then(() => { woken = true; });
    await h.manager.shutdown();
    await wake;
    expect(woken).toBe(true);
  });

  it('defers once on graceful shutdown, without racing duplicate shutdown requests', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    await Promise.all([h.manager.shutdown(), h.manager.shutdown()]);
    expect(h.page.defer).toHaveBeenCalledOnce();
    expect(h.page.close).toHaveBeenCalledOnce();
  });

  it('marks a pending payment unknown on shutdown without trying deferral', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    await h.manager.submit('purchase-1', '123456', 'attempt-1');
    await h.manager.shutdown();
    expect(h.record().state).toBe('UNKNOWN');
    expect(h.page.defer).not.toHaveBeenCalled();
  });

  it('closes the browser on shutdown even when the database cannot record the result', async () => {
    const h = harness();
    await h.manager.prepare('watch-1', 'seat', expiresAt, h.page);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (h.repository.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Database unavailable'));
    await h.manager.shutdown();
    expect(h.page.close).toHaveBeenCalledOnce();
    expect(h.record().state).toBe('WAITING_FOR_BLIK'); // Recovered as UNKNOWN on next startup.
    vi.restoreAllMocks();
  });
});
