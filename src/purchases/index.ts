import { PurchaseManager } from './purchaseManager.js';
import { purchaseRepository, recoverLostPurchases } from './purchaseRepository.js';
import { notifyPurchase } from './purchaseNotifications.js';

export const purchaseManager = new PurchaseManager(purchaseRepository, notifyPurchase);

export async function initializePurchases(): Promise<void> {
  for (const session of await recoverLostPurchases()) notifyPurchase(session);
}
