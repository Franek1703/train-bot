import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import { PurchaseError, type RemoteAction, type RemoteFrame, type RemoteIntent, type RemotePage, type RemoteTarget } from './types.js';

const payName = /^zapłać(?: teraz)?(?:\s+[\d\s,.]+\s*zł)?$/i;
const deferName = /^(?:zapłać później|przejdź do oczekujących na płatność)$/i;

/** One browser page; frames and input values are never written to disk or logs. */
export class IntercityRemotePage implements RemotePage {
  private readonly snapshots = new Map<string, { created: number; url: string; targets: Map<string, { handle: ElementHandle; data: RemoteTarget }> }>();

  constructor(private readonly page: Page) {}

  invalidate(): void {
    for (const frame of this.snapshots.values()) for (const target of frame.targets.values()) void target.handle.dispose().catch(() => {});
    this.snapshots.clear();
  }

  async frame(): Promise<RemoteFrame> {
    for (const [id, frame] of this.snapshots) {
      if (Date.now() - frame.created > 5_000 || this.snapshots.size >= 8) {
        this.snapshots.delete(id);
        for (const target of frame.targets.values()) await target.handle.dispose().catch(() => {});
      }
    }
    const id = randomUUID();
    const targets = new Map<string, { handle: ElementHandle; data: RemoteTarget }>();
    const handles = await this.page.locator('button, a, label, input, textarea, select, [role="button"], [contenteditable="true"]').elementHandles();
    try {
      for (const handle of handles) {
        const metadata = await handle.evaluate((raw) => {
          const element = raw as HTMLElement;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight
            || rect.right <= 0 || rect.left >= innerWidth || getComputedStyle(element).visibility === 'hidden') return null;
          const node = element as HTMLInputElement;
          if (node.disabled || element.getAttribute('aria-disabled') === 'true') return null;
          const input = element.matches('textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="hidden"])');
          const label = (element.getAttribute('aria-label') || node.labels?.[0]?.textContent || (!input ? element.textContent : '') || node.placeholder || element.tagName).replace(/\s+/g, ' ').trim().slice(0, 160);
          return {
            label, kind: element.tagName === 'SELECT' ? 'select' as const : input ? 'input' as const : 'click' as const,
            sensitive: node.type === 'password' || /blik|blick|hasło|password/i.test(`${label} ${node.id} ${node.name}`),
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            options: element.tagName === 'SELECT' ? Array.from((element as HTMLSelectElement).options).map((option) => ({ value: option.value, label: option.text })) : undefined,
          };
        }).catch(() => null);
        if (!metadata) { await handle.dispose(); continue; }
        const targetId = randomUUID();
        targets.set(targetId, { handle, data: { id: targetId, ...metadata } });
      }
      const viewport = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const buffer = await this.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5_000,
        mask: [this.page.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]')],
      });
      this.snapshots.set(id, { created: Date.now(), url: this.page.url(), targets });
      return { id, image: `data:image/jpeg;base64,${buffer.toString('base64')}`, ...viewport, targets: [...targets.values()].map((target) => target.data) };
    } catch {
      for (const handle of handles) await handle.dispose().catch(() => {});
      throw new PurchaseError('Nie można pobrać aktualnego obrazu strony.', 503);
    }
  }

  async action(action: RemoteAction, intercept: (intent: RemoteIntent) => Promise<void>): Promise<void> {
    const frame = this.snapshots.get(action.frameId);
    if (!frame || Date.now() - frame.created > 5_000 || frame.url !== this.page.url()) {
      throw new PurchaseError('Widok strony zmienił się. Poczekaj na aktualny obraz.');
    }
    try {
      if (action.kind === 'scroll') { await this.page.mouse.wheel(0, action.deltaY); return; }
      if (action.kind === 'key') {
        if (action.key === 'Enter') {
          const label = await this.page.evaluate(() => {
            const element = document.activeElement as HTMLInputElement | null;
            const button = element?.matches('button, [role="button"]') ? element : element?.form?.querySelector('button[type="submit"], button:not([type])');
            return button?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          });
          if (payName.test(label)) await intercept('submit');
          else if (deferName.test(label)) await intercept('defer');
          else throw new PurchaseError('Wybierz widoczny przycisk na stronie zamiast Enter.');
        } else await this.page.keyboard.press(action.key);
        return;
      }
      const target = frame.targets.get(action.targetId);
      if (!target) throw new PurchaseError('Element nie jest dostępny w tym widoku.');
      const current = await target.handle.boundingBox();
      const data = target.data;
      if (!current || Math.abs(current.x - data.x) > 2 || Math.abs(current.y - data.y) > 2
        || Math.abs(current.width - data.width) > 2 || Math.abs(current.height - data.height) > 2) {
        throw new PurchaseError('Element przesunął się. Poczekaj na aktualny obraz.');
      }
      if (action.kind === 'fill') {
        if (data.kind !== 'input') throw new PurchaseError('Wybrany element nie jest polem tekstowym.', 400);
        await target.handle.fill(action.text, { timeout: 5_000 });
      } else if (action.kind === 'select') {
        if (data.kind !== 'select') throw new PurchaseError('Wybrany element nie jest listą.', 400);
        await target.handle.selectOption(action.value, { timeout: 5_000 });
      } else {
        // Inspect the actual current element, not the client label or screenshot text.
        const name = await target.handle.evaluate((raw) => {
          const element = raw as HTMLElement;
          const button = element.closest('button, a, [role="button"]');
          return (button?.getAttribute('aria-label') || button?.textContent || '').replace(/\s+/g, ' ').trim();
        });
        if (payName.test(name)) await intercept('submit');
        else if (deferName.test(name)) await intercept('defer');
        else await target.handle.click({ timeout: 5_000 });
      }
    } catch (error) {
      // Playwright fill exceptions contain the input value. Never propagate them.
      if (error instanceof PurchaseError) throw error;
      throw new PurchaseError('Nie udało się wykonać czynności na stronie. Odśwież widok.');
    } finally { this.invalidate(); }
  }
}
