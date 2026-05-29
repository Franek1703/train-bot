import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: sendMock,
    },
  })),
}));

describe('EmailNotifier', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('sends seat availability email through Resend', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { EmailNotifier } = await import('../src/notifications/emailNotifier.js');
    const notifier = new EmailNotifier({
      apiKey: 'test-key',
      from: 'Intercity Monitor <notifications@example.com>',
      to: 'user@example.com',
      timezone: 'Europe/Warsaw',
    });

    const result = await notifier.sendSeatAvailable({
      watch: {
        id: 'watch-1',
        origin: 'Warszawa Centralna',
        destination: 'Gdańsk Główny',
        travelDate: new Date('2026-06-15T00:00:00.000Z'),
        trainNumber: 'EIP 3500',
        departureTime: '08:25',
        travelClass: 2,
        passengers: 1,
      },
      result: {
        status: 'AVAILABLE_WITH_SEAT',
        available: true,
        seatAvailable: true,
        trainNumber: 'EIP 3500',
        departureTime: '08:25',
        purchaseUrl: 'https://www.intercity.pl/',
      },
      availabilityCheck: {
        id: 'check-1',
      },
      detectedAt: new Date('2026-06-15T12:32:00.000Z'),
    } as Parameters<typeof notifier.sendSeatAvailable>[0]);

    expect(result.status).toBe('sent');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Intercity Monitor <notifications@example.com>',
        to: 'user@example.com',
        subject: 'Seat available: EIP 3500 Warszawa Centralna -> Gdańsk Główny',
      }),
    );
  });

  it('returns failed when Resend throws', async () => {
    sendMock.mockRejectedValue(new Error('network failed'));
    const { EmailNotifier } = await import('../src/notifications/emailNotifier.js');
    const notifier = new EmailNotifier({
      apiKey: 'test-key',
      from: 'Intercity Monitor <notifications@example.com>',
      to: 'user@example.com',
      timezone: 'Europe/Warsaw',
    });

    const result = await notifier.sendTest();

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('network failed');
  });
});
