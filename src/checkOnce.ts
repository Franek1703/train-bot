import { runSchedulerTick } from './scheduler/scheduler.js';
import { findActiveWatches } from './watches/watchRepository.js';
import { prisma } from './db/client.js';
import { activePurchaseStates } from './purchases/types.js';

if (await prisma.purchaseSession.count({ where: { state: { in: activePurchaseStates } } })) {
  throw new Error('Konto Intercity ma aktywną sesję zakupu. Poczekaj na zakończenie płatności.');
}
if ((await findActiveWatches()).some((watch) => watch.purchaseMode === 'blik')) {
  throw new Error('Tryb BLIK wymaga działającego backendu i dashboardu. Użyj „Sprawdź teraz” w dashboardzie.');
}
await runSchedulerTick({ force: true });
