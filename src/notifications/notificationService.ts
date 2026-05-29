import { EmailNotifier } from './emailNotifier.js';
import { saveNotificationResult } from './notificationRepository.js';
import type { Notifier, SeatAvailableNotificationInput } from './types.js';

let notifier: Notifier | undefined;

function getNotifier(): Notifier {
  notifier ??= new EmailNotifier();
  return notifier;
}

export function setNotifierForTesting(nextNotifier: Notifier | undefined): void {
  notifier = nextNotifier;
}

export async function notifySeatAvailable(input: SeatAvailableNotificationInput): Promise<void> {
  const result = await getNotifier().sendSeatAvailable(input);
  await saveNotificationResult(input, result);

  if (result.status === 'failed') {
    throw new Error(result.errorMessage ?? 'Email notification failed');
  }
}

export async function sendTestNotification(): Promise<void> {
  const result = await getNotifier().sendTest();

  if (result.status === 'failed') {
    throw new Error(result.errorMessage ?? 'Test email notification failed');
  }

  console.log(`Test email notification sent to ${result.target}.`);
}
