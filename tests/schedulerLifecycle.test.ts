import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkAvailabilityMock = vi.fn();
const saveAvailabilityCheckMock = vi.fn();
const notifySeatAvailableMock = vi.fn();
const updateLastNotifiedAtMock = vi.fn();
const updateWatchAfterCheckMock = vi.fn();
const setWatchActiveMock = vi.fn();
const writeTextArtifactMock = vi.fn();
const createArtifactRecordMock = vi.fn();
const createWatchErrorMock = vi.fn();

vi.mock('../src/checker/intercityChecker.js', () => ({
  PlaywrightIntercityChecker: vi.fn().mockImplementation(() => ({
    checkAvailability: checkAvailabilityMock,
  })),
}));

vi.mock('../src/checker/availabilityRepository.js', () => ({
  saveAvailabilityCheck: saveAvailabilityCheckMock,
}));

vi.mock('../src/notifications/notificationService.js', () => ({
  notifySeatAvailable: notifySeatAvailableMock,
}));

vi.mock('../src/watches/watchRepository.js', () => ({
  findActiveWatches: vi.fn(),
  updateLastNotifiedAt: updateLastNotifiedAtMock,
  updateWatchAfterCheck: updateWatchAfterCheckMock,
  setWatchActive: setWatchActiveMock,
}));

vi.mock('../src/artifacts/artifactRepository.js', () => ({
  writeTextArtifact: writeTextArtifactMock,
  createArtifactRecord: createArtifactRecordMock,
  contentTypeForPath: vi.fn((filePath: string) =>
    filePath.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8',
  ),
}));

vi.mock('../src/errors/errorRepository.js', () => ({
  createWatchError: createWatchErrorMock,
}));

const baseWatch = {
  id: '47f27fc9-d00a-44fe-a2fd-c7e04df9f189',
  origin: 'Warszawa Centralna',
  destination: 'Gdańsk Główny',
  travelDate: new Date('2026-06-15T00:00:00.000Z'),
  trainNumber: 'EIP 3500',
  departureTime: '08:25',
  travelClass: 2,
  passengers: 1,
  lastKnownStatus: 'SOLD_OUT',
  consecutiveErrors: 0,
};

describe('processSingleWatch lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    saveAvailabilityCheckMock.mockResolvedValue({
      id: 'check-1',
      checkedAt: new Date('2026-06-15T12:00:00.000Z'),
    });
    writeTextArtifactMock.mockResolvedValue({ id: 'log-1' });
  });

  it('sends email and stops the watcher when a seat is found', async () => {
    checkAvailabilityMock.mockResolvedValue({
      status: 'AVAILABLE_WITH_SEAT',
      available: true,
      seatAvailable: true,
      screenshotPath: '/tmp/summary.png',
    });
    createArtifactRecordMock.mockResolvedValueOnce({ id: 'screenshot-1' });
    const { processSingleWatch } = await import('../src/scheduler/scheduler.js');

    await processSingleWatch(baseWatch as Parameters<typeof processSingleWatch>[0]);

    expect(notifySeatAvailableMock).toHaveBeenCalledOnce();
    expect(updateLastNotifiedAtMock).toHaveBeenCalledWith(baseWatch.id, expect.any(Date));
    expect(setWatchActiveMock).toHaveBeenCalledWith(baseWatch.id, false);
  });

  it('creates an error record with artifacts when a check fails', async () => {
    checkAvailabilityMock.mockResolvedValue({
      status: 'SEARCH_FAILED',
      available: false,
      seatAvailable: false,
      errorMessage: 'Search failed',
      screenshotPath: '/tmp/error.png',
      diagnosticPath: '/tmp/error.txt',
      pageState: {
        currentUrl: 'https://ebilet.intercity.pl/',
        title: 'Intercity',
        bodyPreview: 'Timeout',
      },
    });
    createArtifactRecordMock
      .mockResolvedValueOnce({ id: 'screenshot-1' })
      .mockResolvedValueOnce({ id: 'diagnostic-1' });
    const { processSingleWatch } = await import('../src/scheduler/scheduler.js');

    await processSingleWatch(baseWatch as Parameters<typeof processSingleWatch>[0]);

    expect(createWatchErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        watchId: baseWatch.id,
        availabilityCheckId: 'check-1',
        message: 'Search failed',
        logArtifactId: 'log-1',
        screenshotArtifactId: 'screenshot-1',
        diagnosticArtifactId: 'diagnostic-1',
      }),
    );
    expect(setWatchActiveMock).not.toHaveBeenCalled();
  });
});
