import { startApiServer } from './api/server.js';
import { runScheduler } from './scheduler/scheduler.js';
import { initializePurchases } from './purchases/index.js';

await initializePurchases();
const server = await startApiServer();
try {
  await runScheduler();
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
