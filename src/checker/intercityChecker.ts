import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox, type Browser, type BrowserType, type Locator, type Page } from 'playwright';
import type { Watch } from '@prisma/client';
import { env } from '../config/env.js';
import { extractSeatAssignment, resultFromStatus } from './parser.js';
import type { AvailabilityChecker, AvailabilityResult } from './types.js';

export class PlaywrightIntercityChecker implements AvailabilityChecker {
  async checkAvailability(watch: Watch): Promise<AvailabilityResult> {
    const startedAt = Date.now();
    logInfo('Starting search URL availability check', {
      watchId: watch.id,
      trainNumber: watch.trainNumber,
      origin: watch.origin,
      destination: watch.destination,
      travelDate: watch.travelDate.toISOString().slice(0, 10),
      searchUrl: watch.journeyUrl,
      headless: env.HEADLESS,
    });

    const browser = await launchIntercityBrowser();
    const context = await browser.newContext({
      locale: 'pl-PL',
      timezoneId: env.TIMEZONE,
    });
    const page = await context.newPage();

    try {
      if (!watch.journeyUrl) {
        throw new Error('Watch is missing stored search URL');
      }

      await openSearchUrl(page, watch);
      await acceptCookiesIfVisible(page);
      const listScreenshotPath = await selectConnection(page, watch);
      const journeyScreenshotPath = await selectTravelClass(page, watch);
      await proceedToSummary(page, watch);
      await loginIfRequired(page, watch);
      await waitForSummary(page, watch);

      const summaryScreenshotPath = await savePageScreenshot(page, watch.id, 'summary');

      const stepScreenshots: Record<string, string | undefined> = {
        list: listScreenshotPath,
        journey: journeyScreenshotPath,
        summary: summaryScreenshotPath,
      };

      const seatAssignment = await readSeatAssignment(page, watch.id);

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
          rawPayload: { currentUrl: page.url(), stepScreenshots },
          screenshotPath: summaryScreenshotPath ?? journeyScreenshotPath ?? listScreenshotPath,
          durationMs: Date.now() - startedAt,
        });
      }

      logInfo('Assigned seat detected on summary page', {
        watchId: watch.id,
        seatAssignment,
      });

      await addToCart(page, watch);
      const cartScreenshotPath = await savePageScreenshot(page, watch.id, 'cart');
      stepScreenshots.cart = cartScreenshotPath;

      return resultFromStatus('AVAILABLE_WITH_SEAT', {
        trainNumber: watch.trainNumber ?? undefined,
        departureTime: watch.departureTime ?? undefined,
        purchaseUrl: page.url(),
        rawStatus: seatAssignment,
        rawPayload: { seatAssignment, currentUrl: page.url(), stepScreenshots },
        screenshotPath: cartScreenshotPath ?? summaryScreenshotPath,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const diagnostic = await captureFailureDiagnostic(page, watch.id);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logError('Availability check failed', {
        watchId: watch.id,
        error: errorMessage,
        screenshotPath: diagnostic.screenshotPath,
        diagnosticPath: diagnostic.diagnosticPath,
        pageState: diagnostic.pageState,
        currentUrl: page.url(),
        durationMs: Date.now() - startedAt,
      });

      return resultFromStatus('SEARCH_FAILED', {
        errorMessage,
        screenshotPath: diagnostic.screenshotPath,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await browser.close();
    }
  }
}

async function openSearchUrl(page: Page, watch: Watch): Promise<void> {
  logInfo('Opening Intercity search URL', {
    watchId: watch.id,
    searchUrl: watch.journeyUrl,
  });

  const navigationError = await navigateToSearchUrl(page, watch);
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch((error) => {
    logError('Search page did not reach domcontentloaded before timeout; continuing to inspect page', {
      watchId: watch.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await page.waitForTimeout(2_000);

  const pageState = await getPageState(page);
  logInfo('Search URL opened', {
    watchId: watch.id,
    currentUrl: pageState.currentUrl,
    title: pageState.title,
    bodyPreview: pageState.bodyPreview,
    navigationRecovered: Boolean(navigationError),
  });

  if (navigationError && pageState.currentUrl === 'about:blank' && !pageState.bodyPreview) {
    throw new Error(`Search URL navigation failed before page content loaded: ${navigationError}`);
  }
}

async function selectConnection(page: Page, watch: Watch): Promise<string | undefined> {
  await waitForSearchResults(page, watch);

  if (!watch.trainNumber || !watch.departureTime) {
    throw new Error('trainNumber and departureTime are required to select a search result');
  }

  const departurePattern = new RegExp(
    `kup bilet.*${watch.departureTime.replace(':', '\\:')}`,
    'i',
  );
  const buyButton = page.getByRole('button', { name: departurePattern }).first();
  const buyButtonCount = await buyButton.count();

  logInfo('Matching search result cards found', {
    watchId: watch.id,
    trainNumber: watch.trainNumber,
    departureTime: watch.departureTime,
    count: buyButtonCount,
  });

  if (buyButtonCount === 0) {
    throw new Error(
      `Could not find train card for ${watch.trainNumber} at ${watch.departureTime}`,
    );
  }

  await buyButton.scrollIntoViewIfNeeded();
  const listScreenshotPath = await savePageScreenshot(page, watch.id, 'list');

  logInfo('Clicking buy ticket button on matching train card', {
    watchId: watch.id,
    trainNumber: watch.trainNumber,
    departureTime: watch.departureTime,
    listScreenshotPath,
  });
  await buyButton.click({ timeout: 10_000 });
  await waitForBookingStep(page, watch.id, 'class_or_journey');

  return listScreenshotPath;
}

async function selectTravelClass(page: Page, watch: Watch): Promise<string | undefined> {
  const classLabel = watch.travelClass === 1 ? /wybierz 1 klasę/i : /wybierz 2 klasę/i;
  const classButton = page.getByRole('button', { name: classLabel }).first();

  if ((await classButton.count()) === 0) {
    if (await hasJourneyStep(page)) {
      logInfo('Travel class step was skipped; journey page already visible', {
        watchId: watch.id,
      });
      return savePageScreenshot(page, watch.id, 'journey');
    }

    throw new Error(`Could not find button for travel class ${watch.travelClass}`);
  }

  logInfo('Selecting travel class', {
    watchId: watch.id,
    travelClass: watch.travelClass,
  });
  await classButton.scrollIntoViewIfNeeded();
  await classButton.click({ timeout: 10_000 });
  await waitForBookingStep(page, watch.id, 'journey');

  return savePageScreenshot(page, watch.id, 'journey');
}

async function proceedToSummary(page: Page, watch: Watch): Promise<void> {
  if (await hasSummaryContent(page)) {
    logInfo('Already on summary page', { watchId: watch.id });
    return;
  }

  const proceedButton = page.getByRole('button', { name: /przejdź do płatności/i }).first();

  if ((await proceedButton.count()) === 0) {
    throw new Error('Could not find PRZEJDŹ DO PŁATNOŚCI button');
  }

  logInfo('Clicking proceed to payment button', { watchId: watch.id });
  await proceedButton.scrollIntoViewIfNeeded();
  await proceedButton.click({ timeout: 10_000 });

  await page
    .getByRole('button', { name: /^zaloguj się$/i })
    .or(page.getByRole('button', { name: /dodaj do koszyka/i }))
    .or(page.getByText(/Kontynuuj jako Gość/i))
    .first()
    .waitFor({ timeout: 45_000 });
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

async function loginIfRequired(page: Page, watch: Watch): Promise<void> {
  if (await hasSummaryContent(page)) {
    logInfo('Login was not required before summary', { watchId: watch.id });
    return;
  }

  const openLoginButton = page
    .getByRole('button', { name: /^zaloguj się$/i })
    .or(page.locator('button:has-text("ZALOGUJ SIĘ")'))
    .first();

  if ((await openLoginButton.count()) === 0) {
    if (await hasSummaryContent(page)) {
      return;
    }

    logInfo('No login prompt found before summary', { watchId: watch.id });
    return;
  }

  logInfo('Opening login form from login modal', { watchId: watch.id });
  await openLoginButton.click({ timeout: 10_000 });
  await page.waitForURL(/sso\.intercity\.pl|ebilet\.intercity\.pl/, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  const emailInput = await findInput(page, [
    page.locator('input[type="email"]').first(),
    page.getByLabel(/e-?mail/i).first(),
    page.locator('input[name*="email" i]').first(),
    page.locator('input[name*="login" i]').first(),
  ]);
  const passwordInput = await findInput(page, [
    page.locator('input[type="password"]').first(),
    page.getByLabel(/hasło|password/i).first(),
    page.locator('input[name*="password" i]').first(),
  ]);

  if (!emailInput || !passwordInput) {
    if (await hasSummaryContent(page)) {
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
  await page.waitForURL(/ebilet\.intercity\.pl/, { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
}

async function waitForSummary(page: Page, watch: Watch): Promise<void> {
  logInfo('Waiting for summary page', { watchId: watch.id });
  await page.getByRole('button', { name: /dodaj do koszyka/i }).first().waitFor({ timeout: 45_000 });
  await page.waitForTimeout(2_000);
}

async function readSeatAssignment(page: Page, watchId: string): Promise<string | undefined> {
  try {
    await waitForSeatAssignmentText(page, watchId);
  } catch {
    logInfo('Assigned seat details did not appear on summary page', { watchId });
  }

  const bodyText = await page.locator('body').innerText({ timeout: 10_000 });
  const seatAssignment = extractSeatAssignment(bodyText);

  if (seatAssignment) {
    return seatAssignment;
  }

  logInfo('Seat assignment text was not found on summary page body', {
    watchId,
    bodyPreview: compactPreview(bodyText, 800),
  });

  return undefined;
}

async function waitForSeatAssignmentText(page: Page, watchId: string): Promise<void> {
  logInfo('Waiting for assigned seat details on summary page', { watchId });

  await page.waitForFunction(
    () => /Wagon\s+\d+/i.test(document.body.innerText) && /miejsce\s+\d+/i.test(document.body.innerText),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(500);
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

  let addedToCart = false;
  try {
    await page.getByText(/dodano do koszyka|bilet dodany|dodano bilet/i).first().waitFor({ timeout: 10_000 });
    addedToCart = true;
  } catch {
    addedToCart =
      (await addToCartButton.count()) === 0 ||
      !(await addToCartButton.isVisible().catch(() => false));
  }

  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  const cartError = bodyText.match(/nie dodano|nie udało się|błąd.*koszyk/i);

  if (cartError) {
    throw new Error(`Ticket was not added to cart: ${cartError[0]}`);
  }

  if (!addedToCart) {
    throw new Error('Ticket was not added to cart after clicking DODAJ DO KOSZYKA');
  }

  logInfo('Ticket added to cart', { watchId: watch.id });
  await page.waitForTimeout(1_000);
}

async function hasJourneyStep(page: Page): Promise<boolean> {
  return (await page.getByRole('button', { name: /przejdź do płatności/i }).count()) > 0;
}

async function hasSummaryContent(page: Page): Promise<boolean> {
  return (await page.getByRole('button', { name: /dodaj do koszyka/i }).count()) > 0;
}

type BookingStepTarget = 'class_or_journey' | 'journey';

async function waitForBookingStep(
  page: Page,
  watchId: string,
  target: BookingStepTarget,
): Promise<void> {
  const classButton = page.getByRole('button', { name: /wybierz [12] klas/i }).first();
  const journeyButton = page.getByRole('button', { name: /przejdź do płatności/i }).first();

  logInfo('Waiting for booking step', { watchId, target });

  if (target === 'class_or_journey') {
    await classButton.or(journeyButton).first().waitFor({ timeout: 45_000 });
    return;
  }

  await journeyButton.waitFor({ timeout: 45_000 });
}

async function waitForSearchResults(page: Page, watch: Watch): Promise<void> {
  const loadingPattern = /Wyszukujemy|Szukamy połączeń|Trwa wyszukiwanie/i;
  const resultsPattern =
    /Lista połączeń|Kup bilet|Brak połączeń|Nie znaleziono|Nie znaleźliśmy/i;

  logInfo('Waiting for Intercity search results', {
    watchId: watch.id,
    pattern: String(resultsPattern),
    timeoutMs: 120_000,
  });

  try {
    await page.getByText(resultsPattern).first().waitFor({ timeout: 120_000 });
    await page.getByText(loadingPattern).first().waitFor({ state: 'hidden', timeout: 120_000 });
    await page.waitForTimeout(1_000);
  } catch (error) {
    const pageState = await getPageState(page);
    throw new Error(
      [
        'Search results did not finish loading before timeout.',
        `currentUrl=${pageState.currentUrl}`,
        `title=${pageState.title ?? ''}`,
        `bodyPreview=${pageState.bodyPreview ?? ''}`,
        `error=${error instanceof Error ? error.message : String(error)}`,
      ].join(' '),
    );
  }

  const pageState = await getPageState(page);
  logInfo('Intercity search results page is ready for train selection', {
    watchId: watch.id,
    currentUrl: pageState.currentUrl,
    bodyPreview: pageState.bodyPreview,
  });
}

async function findInput(page: Page, locators: Locator[]): Promise<Locator | undefined> {
  for (const locator of locators) {
    if ((await locator.count()) > 0) {
      return locator;
    }
  }

  return undefined;
}

async function navigateToSearchUrl(page: Page, watch: Watch): Promise<string | undefined> {
  try {
    await page.goto(watch.journeyUrl!, { waitUntil: 'commit', timeout: 45_000 });
    return undefined;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const pageState = await getPageState(page);

    logError('Search URL navigation did not complete before timeout; stopping load and inspecting page', {
      watchId: watch.id,
      searchUrl: watch.journeyUrl,
      error: errorMessage,
      currentUrl: pageState.currentUrl,
      title: pageState.title,
      bodyPreview: pageState.bodyPreview,
    });

    await stopPageLoading(page, watch.id);
    return errorMessage;
  }
}

async function stopPageLoading(page: Page, watchId: string): Promise<void> {
  await page.evaluate(() => window.stop()).catch((error) => {
    logError('Could not stop page loading after navigation failure', {
      watchId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

interface PageState {
  currentUrl: string;
  title?: string;
  bodyPreview?: string;
}

async function getPageState(page: Page): Promise<PageState> {
  const [title, bodyPreview] = await Promise.all([
    page.title().catch(() => undefined),
    page
      .locator('body')
      .innerText({ timeout: 2_000 })
      .then((text) => compactPreview(text))
      .catch(() => undefined),
  ]);

  return {
    currentUrl: page.url(),
    title,
    bodyPreview,
  };
}

function compactPreview(text: string, limit = 500): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

interface FailureDiagnostic {
  screenshotPath?: string;
  diagnosticPath?: string;
  pageState: PageState;
}

async function savePageScreenshot(
  page: Page,
  watchId: string,
  label: string,
): Promise<string | undefined> {
  if (!env.SAVE_SCREENSHOTS) {
    return undefined;
  }

  await mkdir(env.SCREENSHOTS_DIR, { recursive: true });
  const screenshotPath = path.join(env.SCREENSHOTS_DIR, `${label}-${watchId}-${Date.now()}.png`);
  const saved = await trySaveScreenshot(page, screenshotPath, true, []);

  if (!saved) {
    logError('Could not save page screenshot', { watchId, label, screenshotPath });
    return undefined;
  }

  logInfo('Saved page screenshot', { watchId, label, screenshotPath });
  return screenshotPath;
}

async function captureFailureDiagnostic(page: Page, watchId: string): Promise<FailureDiagnostic> {
  const pageState = await getPageState(page);

  if (!env.SAVE_SCREENSHOTS) {
    return { pageState };
  }

  await mkdir(env.SCREENSHOTS_DIR, { recursive: true });
  await stopPageLoading(page, watchId);

  const timestamp = Date.now();
  const screenshotPath = path.join(env.SCREENSHOTS_DIR, `error-${watchId}-${timestamp}.png`);
  const screenshotErrors: string[] = [];

  const fullPageSaved = await trySaveScreenshot(page, screenshotPath, true, screenshotErrors);
  if (fullPageSaved) {
    logInfo('Saved failure screenshot', {
      watchId,
      screenshotPath,
      fullPage: true,
    });

    return { screenshotPath, pageState };
  }

  const viewportSaved = await trySaveScreenshot(page, screenshotPath, false, screenshotErrors);
  if (viewportSaved) {
    logInfo('Saved failure screenshot', {
      watchId,
      screenshotPath,
      fullPage: false,
    });

    return { screenshotPath, pageState };
  }

  const diagnosticPath = path.join(env.SCREENSHOTS_DIR, `error-${watchId}-${timestamp}.txt`);
  await writeDiagnosticFile(diagnosticPath, pageState, screenshotErrors);

  logError('Could not save failure screenshot; wrote text diagnostic instead', {
    watchId,
    diagnosticPath,
    screenshotErrors,
    pageState,
  });

  return { diagnosticPath, pageState };
}

async function trySaveScreenshot(
  page: Page,
  screenshotPath: string,
  fullPage: boolean,
  screenshotErrors: string[],
): Promise<boolean> {
  try {
    await page.screenshot({ path: screenshotPath, fullPage, timeout: 10_000 });
    return true;
  } catch (error) {
    screenshotErrors.push(
      `${fullPage ? 'fullPage' : 'viewport'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function writeDiagnosticFile(
  diagnosticPath: string,
  pageState: PageState,
  screenshotErrors: string[],
): Promise<void> {
  await writeFile(
    diagnosticPath,
    [
      `currentUrl=${pageState.currentUrl}`,
      `title=${pageState.title ?? ''}`,
      `bodyPreview=${pageState.bodyPreview ?? ''}`,
      `screenshotErrors=${screenshotErrors.join(' | ')}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function logInfo(message: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', message, ...context }));
}

function logError(message: string, context: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', message, ...context }));
}

export function trainNumberRegex(trainNumber: string): RegExp {
  return new RegExp(trainNumber.trim().replace(/\s+/g, '\\s*'), 'i');
}

async function launchIntercityBrowser(): Promise<Browser> {
  const browserType = resolveIntercityBrowserType();
  logInfo('Launching browser for Intercity check', {
    browser: browserType.name(),
    headless: env.HEADLESS,
  });

  return browserType.launch({ headless: env.HEADLESS });
}

function resolveIntercityBrowserType(): BrowserType {
  // Intercity blocks Chromium headless navigation (page stays on about:blank).
  // Firefox works reliably in both headless and headed mode.
  if (env.HEADLESS) {
    return firefox;
  }

  return chromium;
}
