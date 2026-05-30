import pLimit from 'p-limit';
import path from 'node:path';
import {
  contentTypeForPath,
  createArtifactRecord,
  writeTextArtifact,
} from '../artifacts/artifactRepository.js';
import { saveAvailabilityCheck } from '../checker/availabilityRepository.js';
import { PlaywrightIntercityChecker } from '../checker/intercityChecker.js';
import { env } from '../config/env.js';
import { disconnectDatabase } from '../db/client.js';
import { createWatchError } from '../errors/errorRepository.js';
import { notifySeatAvailable } from '../notifications/notificationService.js';
import {
  findActiveWatches,
  updateLastNotifiedAt,
  updateWatchAfterCheck,
  setWatchActive,
} from '../watches/watchRepository.js';
import { captureCheckLogs } from './checkLogger.js';
import {
  isWatchDueForCheck,
  nextConsecutiveErrors,
  shouldSendNotification,
} from './watchState.js';

const checker = new PlaywrightIntercityChecker();

interface SchedulerTickOptions {
  force?: boolean;
}

export async function runSchedulerTick(options: SchedulerTickOptions = {}): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Scheduler tick started',
      maxParallelChecks: env.MAX_PARALLEL_CHECKS,
      force: options.force ?? false,
    }),
  );

  const activeWatches = await findActiveWatches();
  const dueWatches = options.force
    ? activeWatches
    : activeWatches.filter((watch) => isWatchDueForCheck(watch));
  const limit = pLimit(env.MAX_PARALLEL_CHECKS);

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Loaded active watches',
      activeWatches: activeWatches.length,
      dueWatches: dueWatches.length,
      watches: activeWatches.map((watch) => ({
        id: watch.id,
        trainNumber: watch.trainNumber,
        origin: watch.origin,
        destination: watch.destination,
        lastKnownStatus: watch.lastKnownStatus,
        lastCheckedAt: watch.lastCheckedAt,
        due: options.force || dueWatches.some((dueWatch) => dueWatch.id === watch.id),
      })),
    }),
  );

  await Promise.all(
    dueWatches.map((watch) =>
      limit(async () => {
        const delayMs = options.force ? 0 : randomDelayMs();
        console.log(
          JSON.stringify({
            level: 'info',
            message: 'Waiting before watch check',
            watchId: watch.id,
            trainNumber: watch.trainNumber,
            delayMs,
          }),
        );
        await sleep(delayMs);
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

export async function processSingleWatch(
  watch: Awaited<ReturnType<typeof findActiveWatches>>[number],
): Promise<Awaited<ReturnType<typeof saveAvailabilityCheck>>> {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Processing watch',
      watchId: watch.id,
      trainNumber: watch.trainNumber,
      origin: watch.origin,
      destination: watch.destination,
      previousStatus: watch.lastKnownStatus,
    }),
  );

  const { result, entries } = await captureCheckLogs(() => checker.checkAvailability(watch));
  const availabilityCheck = await saveAvailabilityCheck(watch.id, result);
  const checkedAt = availabilityCheck.checkedAt;
  const consecutiveErrors = nextConsecutiveErrors(watch, result.status);
  const logArtifact = await writeTextArtifact({
    watchId: watch.id,
    availabilityCheckId: availabilityCheck.id,
    kind: 'log',
    label: 'check-log',
    fileName: `check-${availabilityCheck.id}.jsonl`,
    content: entries.map((entry) => JSON.stringify(entry)).join('\n'),
    contentType: 'application/x-ndjson; charset=utf-8',
  });
  const screenshotArtifact = result.screenshotPath
    ? await createFileArtifact(watch.id, availabilityCheck.id, result.screenshotPath, 'screenshot')
    : undefined;
  const diagnosticArtifact = result.diagnosticPath
    ? await createFileArtifact(watch.id, availabilityCheck.id, result.diagnosticPath, 'diagnostic')
    : undefined;

  console.log(
    JSON.stringify({
      level: result.status === 'SEARCH_FAILED' ? 'error' : 'info',
      message: 'Availability check saved',
      watchId: watch.id,
      availabilityCheckId: availabilityCheck.id,
      status: result.status,
      available: result.available,
      seatAvailable: result.seatAvailable,
      errorMessage: result.errorMessage,
      screenshotPath: result.screenshotPath,
      durationMs: result.durationMs,
      consecutiveErrors,
    }),
  );

  await updateWatchAfterCheck({
    watchId: watch.id,
    status: result.status,
    checkedAt,
    consecutiveErrors,
  });

  if (result.status === 'SEARCH_FAILED') {
    await createWatchError({
      watchId: watch.id,
      availabilityCheckId: availabilityCheck.id,
      status: result.status,
      message: result.errorMessage ?? 'Availability check failed',
      currentUrl: result.pageState?.currentUrl,
      pageTitle: result.pageState?.title,
      bodyPreview: result.pageState?.bodyPreview,
      logArtifactId: logArtifact.id,
      screenshotArtifactId: screenshotArtifact?.id,
      diagnosticArtifactId: diagnosticArtifact?.id,
    });
  }

  const shouldNotify = shouldSendNotification({
    previousStatus: watch.lastKnownStatus,
    currentStatus: result.status,
  });

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'Notification decision',
      watchId: watch.id,
      previousStatus: watch.lastKnownStatus,
      currentStatus: result.status,
      shouldNotify,
    }),
  );

  if (shouldNotify) {
    await notifySeatAvailable({
      watch,
      result,
      availabilityCheck,
      detectedAt: checkedAt,
    });
    await updateLastNotifiedAt(watch.id, new Date());
    await setWatchActive(watch.id, false);
  }

  return availabilityCheck;
}

async function createFileArtifact(
  watchId: string,
  availabilityCheckId: string,
  filePath: string,
  kind: string,
) {
  return createArtifactRecord({
    watchId,
    availabilityCheckId,
    kind,
    label: path.basename(filePath),
    filePath,
    contentType: contentTypeForPath(filePath),
  });
}

function randomDelayMs(): number {
  return 5_000 + Math.floor(Math.random() * 25_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
