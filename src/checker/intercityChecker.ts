import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import type { Watch } from '@prisma/client';
import { env } from '../config/env.js';
import { parseAvailabilityText, resultFromStatus } from './parser.js';
import type { AvailabilityChecker, AvailabilityResult } from './types.js';

export class PlaywrightIntercityChecker implements AvailabilityChecker {
  async checkAvailability(watch: Watch): Promise<AvailabilityResult> {
    const startedAt = Date.now();
    const browser = await chromium.launch({ headless: env.HEADLESS });
    const page = await browser.newPage();

    try {
      await page.goto(env.PKP_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await acceptCookiesIfVisible(page);
      await fillSearchForm(page, watch);
      await submitSearch(page);
      await waitForResults(page);

      const trainCard = await findTrainCard(page, watch);
      if (!trainCard) {
        return resultFromStatus('TRAIN_NOT_FOUND', {
          trainNumber: watch.trainNumber ?? undefined,
          departureTime: watch.departureTime ?? undefined,
          durationMs: Date.now() - startedAt,
        });
      }

      const rawStatus = await trainCard.innerText({ timeout: 10_000 });
      const parsed = parseAvailabilityText(rawStatus);

      return {
        ...parsed,
        trainNumber: watch.trainNumber ?? extractTrainNumber(rawStatus),
        departureTime: watch.departureTime ?? extractTime(rawStatus, 0),
        arrivalTime: extractTime(rawStatus, 1),
        price: extractPrice(rawStatus),
        purchaseUrl: page.url(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const screenshotPath = await saveErrorScreenshot(page, watch.id);

      return resultFromStatus('SEARCH_FAILED', {
        errorMessage: error instanceof Error ? error.message : String(error),
        screenshotPath,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await browser.close();
    }
  }
}

async function acceptCookiesIfVisible(page: Page): Promise<void> {
  const buttons = page.getByRole('button', {
    name: /akcept|accept|zgadzam|rozumiem/i,
  });

  if ((await buttons.count()) > 0) {
    await buttons.first().click({ timeout: 5_000 }).catch(() => undefined);
  }
}

async function fillSearchForm(page: Page, watch: Watch): Promise<void> {
  await fillFirstMatchingInput(page, [/skąd/i, /from/i, /stacja początkowa/i], watch.origin);
  await fillFirstMatchingInput(page, [/dokąd/i, /to/i, /stacja końcowa/i], watch.destination);
  await fillFirstMatchingInput(page, [/data/i, /date/i], formatDateForInput(watch.travelDate));
}

async function fillFirstMatchingInput(page: Page, names: RegExp[], value: string): Promise<void> {
  for (const name of names) {
    const input = page.getByRole('textbox', { name }).first();
    if ((await input.count()) > 0) {
      await input.fill(value, { timeout: 10_000 });
      await page.keyboard.press('Enter').catch(() => undefined);
      return;
    }
  }

  throw new Error(`Could not find input for ${names.map(String).join(', ')}`);
}

async function submitSearch(page: Page): Promise<void> {
  const submit = page.getByRole('button', { name: /szukaj|search|wyszukaj/i }).first();

  if ((await submit.count()) === 0) {
    throw new Error('Could not find search button');
  }

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => undefined),
    submit.click({ timeout: 10_000 }),
  ]);
}

async function waitForResults(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}

async function findTrainCard(page: Page, watch: Watch): Promise<Locator | null> {
  if (!watch.trainNumber) {
    return page.locator('body');
  }

  const trainNumber = watch.trainNumber.replace(/\s+/g, '\\s*');
  const card = page
    .locator('article, li, tr, [class*="connection"], [class*="result"], [class*="journey"]')
    .filter({ hasText: new RegExp(trainNumber, 'i') });

  if (watch.departureTime) {
    const withTime = card.filter({ hasText: watch.departureTime });
    if ((await withTime.count()) > 0) {
      return withTime.first();
    }
  }

  if ((await card.count()) > 0) {
    return card.first();
  }

  return null;
}

async function saveErrorScreenshot(page: Page, watchId: string): Promise<string | undefined> {
  await mkdir(env.SCREENSHOTS_DIR, { recursive: true });
  const screenshotPath = path.join(env.SCREENSHOTS_DIR, `error-${watchId}-${Date.now()}.png`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return undefined;
  }
}

function formatDateForInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function extractTrainNumber(text: string): string | undefined {
  return text.match(/\b(?:EIP|EIC|IC|TLK)\s*\d+\b/i)?.[0];
}

function extractTime(text: string, index: number): string | undefined {
  return [...text.matchAll(/\b\d{2}:\d{2}\b/g)][index]?.[0];
}

function extractPrice(text: string): string | undefined {
  return text.match(/\b\d+[,.]\d{2}\s*(?:zł|PLN)\b/i)?.[0];
}
