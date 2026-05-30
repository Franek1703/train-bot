import { startApiServer } from './api/server.js';
import { runScheduler } from './scheduler/scheduler.js';

await startApiServer();
await runScheduler();
