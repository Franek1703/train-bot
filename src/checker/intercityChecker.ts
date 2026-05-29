import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import type { Watch } from '@prisma/client';
import { env } from '../config/env.js';
import { extractSeatAssignment, resultFromStatus } from './parser.js';
import type { AvailabilityChecker, AvailabilityResult } from './types.js';

export class PlaywrightIntercityChecker implements AvailabilityChecker {
  async checkAvailability(watch: Watch): Promise<AvailabilityResult> {
    const startedAt = Date.now();
    logInfo('Starting direct journey availability check', {
      watchId: watch.id,
      trainNumber: watch.trainNumber,
      origin: watch.origin,
      destination: watch.destination,
      travelDate: watch.travelDate.toISOString().slice(0, 10),
      journeyUrl: watch.journeyUrl,
      headless: env.HEADLESS,
    });

    const browser = await chromium.launch({ headless: env.HEADLESS });
    const page = await browser.newPage();

    try {
      if (!watch.journeyUrl) {
        throw new Error('Watch is missing journeyUrl');
      }

      await openJourneyUrl(page, watch);
      await acceptCookiesIfVisible(page);
      await proceedToSummary(page, watch);
      await loginIfRequired(page, watch);
      await waitForSummary(page, watch);

      const bodyText = await page.locator('body').innerText({ timeout: 10_000 });
      const seatAssignment = extractSeatAssignment(bodyText);

      if (!seatAssignment) {
        logInfo('Summary page did not contain assigned seat text', {
          watchId: watch.id,
          currentUrl: page.url(),
        });

        return resultFromStatus('AVAILABLE_WITHOUT_SEAT', {
          trainNumber: watch.trainNumber ?? undefined,
          departureTime: watch.departureTime ?? undefined,
          purchaseUrl: page.url(),
          rawStatus: 'No assigned seat detected on summary page',
          rawPayload: { currentUrl: page.url() },
          durationMs: Date.now() - startedAt,
        });
      }

      logInfo('Assigned seat detected on summary page', {
        watchId: watch.id,
        seatAssignment,
      });

      await addToCart(page, watch);

      return resultFromStatus('AVAILABLE_WITH_SEAT', {
        trainNumber: watch.trainNumber ?? undefined,
        departureTime: watch.departureTime ?? undefined,
        purchaseUrl: page.url(),
        rawStatus: seatAssignment,
        rawPayload: { seatAssignment, currentUrl: page.url() },
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const screenshotPath = await saveErrorScreenshot(page, watch.id);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logError('Availability check failed', {
        watchId: watch.id,
        error: errorMessage,
        screenshotPath,
        currentUrl: page.url(),
        durationMs: Date.now() - startedAt,
      });

      return resultFromStatus('SEARCH_FAILED', {
        errorMessage,
        screenshotPath,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await browser.close();
    }
  }
}

async function openJourneyUrl(page: Page, watch: Watch): Promise<void> {
  logInfo('Opening Intercity journey URL', {
    watchId: watch.id,
    journeyUrl: watch.journeyUrl,
  });

  await page.goto(watch.journeyUrl!, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch((error) => {
    logError('Journey page did not reach domcontentloaded before timeout', {
      watchId: watch.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await page.waitForTimeout(2_000);

  logInfo('Journey URL opened', {
    watchId: watch.id,
    currentUrl: page.url(),
    title: await page.title().catch(() => undefined),
  });
}

async function acceptCookiesIfVisible(page: Page): Promise<void> {
  const cookieDialog = page.locator('#CybotCookiebotDialog, [aria-label*="cookie" i]').first();

  if ((await cookieDialog.count()) === 0) {
    logInfo('Cookie modal was not found');
    return;
  }

  const selectors = [
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button:has-text("Zezwól na wszystkie")',
    'button:has-text("Zaakceptuj niezbędne")',
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) {
      continue;
    }

    await button.click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    logInfo('Cookie modal accepted', { selector });
    return;
  }

  throw new Error('Cookie modal was visible, but no known accept button could be clicked');
}

async function proceedToSummary(page: Page, watch: Watch): Promise<void> {
  if (await isSummaryVisible(page)) {
    logInfo('Already on summary page', { watchId: watch.id });
    return;
  }

  await waitForText(page, /Twoja podróż|Wybierz miejsce|Przejdź do płatności/i, watch.id);

  const proceedButton = page
    .getByRole('button', { name: /przejdź do płatności/i })
    .or(page.locator('button:has-text("PRZEJDŹ DO PŁATNOŚCI")'))
    .first();

  if ((await proceedButton.count()) === 0) {
    throw new Error('Could not find PRZEJDŹ DO PŁATNOŚCI button');
  }

  logInfo('Clicking proceed to payment button', { watchId: watch.id });
  await proceedButton.scrollIntoViewIfNeeded();
  await proceedButton.click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
}

async function loginIfRequired(page: Page, watch: Watch): Promise<void> {
  if (await isSummaryVisible(page)) {
    logInfo('Login was not required before summary', { watchId: watch.id });
    return;
  }

  const openLoginButton = page
    .getByRole('button', { name: /^zaloguj się$/i })
    .or(page.locator('button:has-text("ZALOGUJ SIĘ")'))
    .first();

  if ((await openLoginButton.count()) > 0) {
    logInfo('Opening login form from login modal', { watchId: watch.id });
    await openLoginButton.click({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
  }

  const emailInput = await findInput(page, [
    page.locator('input[type="email"]').first(),
    page.getByLabel(/e-?mail/i).first(),
    page.locator('input[name*="email" i]').first(),
  ]);
  const passwordInput = await findInput(page, [
    page.locator('input[type="password"]').first(),
    page.getByLabel(/hasło|password/i).first(),
    page.locator('input[name*="password" i]').first(),
  ]);

  if (!emailInput || !passwordInput) {
    if (await isSummaryVisible(page)) {
      return;
    }

    throw new Error('Login was required, but email/password inputs were not found');
  }

  if (!env.INTERCITY_EMAIL || !env.INTERCITY_PASSWORD) {
    throw new Error('INTERCITY_EMAIL and INTERCITY_PASSWORD are required when login is shown');
  }

  logInfo('Filling Intercity login form', {
    watchId: watch.id,
    email: env.INTERCITY_EMAIL,
  });
  await emailInput.fill(env.INTERCITY_EMAIL, { timeout: 10_000 });
  await passwordInput.fill(env.INTERCITY_PASSWORD, { timeout: 10_000 });

  const submitButton = page
    .getByRole('button', { name: /^zaloguj się$/i })
    .or(page.locator('button:has-text("ZALOGUJ SIĘ")'))
    .last();

  if ((await submitButton.count()) === 0) {
    throw new Error('Could not find final login submit button');
  }

  logInfo('Submitting Intercity login form', { watchId: watch.id });
  await submitButton.click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
}

async function waitForSummary(page: Page, watch: Watch): Promise<void> {
  logInfo('Waiting for summary page', { watchId: watch.id });
  await page.getByText(/Podsumowanie/i).first().waitFor({ timeout: 45_000 });
}

async function addToCart(page: Page, watch: Watch): Promise<void> {
  const addToCartButton = page
    .getByRole('button', { name: /dodaj do koszyka/i })
    .or(page.locator('button:has-text("DODAJ DO KOSZYKA")'))
    .first();

  if ((await addToCartButton.count()) === 0) {
    throw new Error('Assigned seat was detected, but DODAJ DO KOSZYKA button was not found');
  }

  logInfo('Clicking add to cart button', { watchId: watch.id });
  await addToCartButton.scrollIntoViewIfNeeded();
  await addToCartButton.click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
}

async function isSummaryVisible(page: Page): Promise<boolean> {
  return (await page.getByText(/Podsumowanie/i).first().count()) > 0;
}

async function waitForText(page: Page, pattern: RegExp, watchId: string): Promise<void> {
  logInfo('Waiting for page text', { watchId, pattern: String(pattern) });
  await page.getByText(pattern).first().waitFor({ timeout: 45_000 });
}

async function findInput(page: Page, locators: Locator[]): Promise<Locator | undefined> {
  for (const locator of locators) {
    if ((await locator.count()) > 0) {
      return locator;
    }
  }

  return undefined;
}

async function saveErrorScreenshot(page: Page, watchId: string): Promise<string | undefined> {
  await mkdir(env.SCREENSHOTS_DIR, { recursive: true });
  const screenshotPath = path.join(env.SCREENSHOTS_DIR, `error-${watchId}-${Date.now()}.png`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 });
    return screenshotPath;
  } catch {
    return undefined;
  }
}

function logInfo(message: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', message, ...context }));
}

function logError(message: string, context: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', message, ...context }));
}
