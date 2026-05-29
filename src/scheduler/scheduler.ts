import pLimit from 'p-limit';
import { saveAvailabilityCheck } from '../checker/availabilityRepository.js';
import { PlaywrightIntercityChecker } from '../checker/intercityChecker.js';
import { env } from '../config/env.js';
import { disconnectDatabase } from '../db/client.js';
import { notifySeatAvailable } from '../notifications/notificationService.js';
import {
  findActiveWatches,
  loadAndSyncWatches,
  updateLastNotifiedAt,
  updateWatchAfterCheck,
} from '../watches/watchRepository.js';
import {
  isWatchDueForCheck,
  nextConsecutiveErrors,
  shouldSendNotification,
} from './watchState.js';

const checker = new PlaywrightIntercityChecker();

export async function runSchedulerTick(): Promise<void> {
  await loadAndSyncWatches(env.WATCHES_CONFIG_PATH);
  const activeWatches = await findActiveWatches();
  const dueWatches = activeWatches.filter((watch) => isWatchDueForCheck(watch));
  const limit = pLimit(env.MAX_PARALLEL_CHECKS);

  await Promise.all(
    dueWatches.map((watch) =>
      limit(async () => {
        await sleep(randomDelayMs());
        await processSingleWatch(watch);
      }),
    ),
  );

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Scheduler tick completed',
      activeWatches: activeWatches.length,
      dueWatches: dueWatches.length,
    }),
  );
}

export async function runScheduler(): Promise<void> {
  let stopped = false;

  const stop = (): void => {
    stopped = true;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    await runSchedulerTick().catch((error) => {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Scheduler tick failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });

    await sleep(env.CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  await disconnectDatabase();
}

async function processSingleWatch(
  watch: Awaited<ReturnType<typeof findActiveWatches>>[number],
): Promise<void> {
  const result = await checker.checkAvailability(watch);
  const availabilityCheck = await saveAvailabilityCheck(watch.id, result);
  const checkedAt = availabilityCheck.checkedAt;

  await updateWatchAfterCheck({
    watchId: watch.id,
    status: result.status,
    checkedAt,
    consecutiveErrors: nextConsecutiveErrors(watch, result.status),
  });

  if (
    shouldSendNotification({
      previousStatus: watch.lastKnownStatus,
      currentStatus: result.status,
    })
  ) {
    await notifySeatAvailable({
      watch,
      result,
      availabilityCheck,
      detectedAt: checkedAt,
    });
    await updateLastNotifiedAt(watch.id, new Date());
  }
}

function randomDelayMs(): number {
  return 5_000 + Math.floor(Math.random() * 25_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
