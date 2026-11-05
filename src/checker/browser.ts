import { chromium, firefox, type Browser, type BrowserType } from 'playwright';
import { env } from '../config/env.js';
import { recordCheckLog } from '../scheduler/checkLogger.js';

export async function launchIntercityBrowser(): Promise<Browser> {
  const browserType = resolveIntercityBrowserType();
  const context = { browser: browserType.name(), headless: env.HEADLESS };
  recordCheckLog('info', 'Launching browser for Intercity check', context);
  console.log(JSON.stringify({ level: 'info', message: 'Launching browser for Intercity check', ...context }));

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
