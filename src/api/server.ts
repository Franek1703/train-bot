import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import type { Server } from 'node:net';
import { ZodError } from 'zod';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getArtifactById } from '../artifacts/artifactRepository.js';
import { listErrors, getErrorById } from '../errors/errorRepository.js';
import { processSingleWatch } from '../scheduler/scheduler.js';
import {
  createWatch,
  deleteWatch,
  findWatchById,
  findWatchDetails,
  findWatches,
  setWatchActive,
  updateWatch,
} from '../watches/watchRepository.js';
import { watchInputSchema, watchUpdateSchema } from './watchSchemas.js';
import { latestPurchase, reviewUnknownPurchase } from '../purchases/purchaseRepository.js';
import { purchaseManager } from '../purchases/index.js';
import { PurchaseError } from '../purchases/types.js';

export const blikInputSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Kod BLIK musi mieć 6 cyfr.'),
  attemptId: z.string().uuid(),
});

interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  parts: string[];
}

export async function startApiServer(): Promise<Server> {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const apiError = normalizeApiError(error);
      sendError(response, apiError.status, apiError.message);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(env.API_PORT, env.API_HOST, resolve);
  });

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'API server started',
      host: env.API_HOST,
      port: env.API_PORT,
    }),
  );

  return server;
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const context = { request, response, url, parts };

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (parts[0] === 'watches') {
    await handleWatches(context);
    return;
  }

  if (parts[0] === 'errors') {
    await handleErrors(context);
    return;
  }

  if (parts[0] === 'artifacts') {
    await handleArtifacts(context);
    return;
  }

  if (parts[0] === 'purchases' && parts.length === 3 && parts[2] === 'blik' && request.method === 'POST') {
    // Private dashboard only; reject cross-site browser payment requests.
    const origin = request.headers.origin;
    if (origin && origin !== new URL(env.DASHBOARD_URL).origin && origin !== env.DASHBOARD_ORIGIN) {
      throw new PurchaseError('Niedozwolone źródło żądania płatności.', 403);
    }
    const input = blikInputSchema.parse(await readJson(request));
    try { await purchaseManager.submit(parts[1], input.code, input.attemptId); }
    finally { input.code = ''; }
    sendJson(response, 202, { accepted: true });
    return;
  }

  sendError(response, 404, 'Not found');
}

async function handleWatches(context: RouteContext): Promise<void> {
  const { request, response, parts } = context;

  if (request.method === 'GET' && parts.length === 1) {
    sendJson(response, 200, { watches: await findWatches() });
    return;
  }

  if (request.method === 'POST' && parts.length === 1) {
    const body = watchInputSchema.parse(await readJson(request));
    sendJson(response, 201, { watch: await createWatch(body) });
    return;
  }

  const watchId = parts[1];
  if (!watchId) {
    sendError(response, 404, 'Not found');
    return;
  }

  if (request.method === 'GET' && parts.length === 2) {
    const watch = await findWatchDetails(watchId);
    if (!watch) {
      sendError(response, 404, 'Watch not found');
      return;
    }

    sendJson(response, 200, { watch });
    return;
  }

  if (request.method === 'PATCH' && parts.length === 2) {
    if (purchaseManager.busy) throw new PurchaseError('Konto Intercity jest zajęte. Poczekaj z edycją watchera.');
    const body = watchUpdateSchema.parse(await readJson(request));
    sendJson(response, 200, { watch: await updateWatch(watchId, body) });
    return;
  }

  if (request.method === 'DELETE' && parts.length === 2) {
    if (purchaseManager.busy) throw new PurchaseError('Konto Intercity jest zajęte. Poczekaj z usunięciem watchera.');
    await deleteWatch(watchId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'POST' && parts[2] === 'stop') {
    sendJson(response, 200, { watch: await setWatchActive(watchId, false) });
    return;
  }

  if (request.method === 'POST' && parts[2] === 'resume') {
    if (purchaseManager.busy) throw new PurchaseError('Konto Intercity jest zajęte. Poczekaj z wznowieniem watchera.');
    const purchase = await latestPurchase(watchId);
    const body = z.object({ acknowledgeUnknown: z.boolean().optional() }).parse(await readJson(request));
    if (purchase?.state === 'UNKNOWN' && !purchase.reviewedAt && !body.acknowledgeUnknown) {
      throw new PurchaseError('Sprawdź zamówienie na koncie Intercity i potwierdź sprawdzenie przed wznowieniem.');
    }
    if (purchase?.state === 'UNKNOWN' && body.acknowledgeUnknown) await reviewUnknownPurchase(purchase.id);
    sendJson(response, 200, { watch: await setWatchActive(watchId, true) });
    return;
  }

  if (request.method === 'POST' && parts[2] === 'check-now') {
    const watch = await findWatchById(watchId);
    if (!watch) {
      sendError(response, 404, 'Watch not found');
      return;
    }
    const lastPurchase = await latestPurchase(watchId);
    if (lastPurchase?.state === 'UNKNOWN' && !lastPurchase.reviewedAt) {
      throw new PurchaseError('Sprawdź zamówienie na koncie Intercity, następnie jawnie wznów watcher.');
    }

    const availabilityCheck = await processSingleWatch(watch);
    sendJson(response, 200, { availabilityCheck });
    return;
  }

  if (request.method === 'GET' && parts.length === 3 && parts[2] === 'purchase') {
    if (!await findWatchById(watchId)) throw new PurchaseError('Watch not found', 404);
    sendJson(response, 200, { purchase: await latestPurchase(watchId), serverTime: new Date().toISOString(), accountBusy: purchaseManager.busy });
    return;
  }

  sendError(response, 404, 'Not found');
}

async function handleErrors(context: RouteContext): Promise<void> {
  const { request, response, parts } = context;

  if (request.method === 'GET' && parts.length === 1) {
    sendJson(response, 200, { errors: await listErrors() });
    return;
  }

  if (request.method === 'GET' && parts[1]) {
    const error = await getErrorById(parts[1]);
    if (!error) {
      sendError(response, 404, 'Error not found');
      return;
    }

    sendJson(response, 200, { error });
    return;
  }

  sendError(response, 404, 'Not found');
}

async function handleArtifacts(context: RouteContext): Promise<void> {
  const { request, response, parts } = context;

  if (request.method !== 'GET' || !parts[1]) {
    sendError(response, 404, 'Not found');
    return;
  }

  const artifact = await getArtifactById(parts[1]);
  if (!artifact) {
    sendError(response, 404, 'Artifact not found');
    return;
  }

  await stat(artifact.filePath);
  response.writeHead(200, {
    'Content-Type': artifact.contentType,
    'Cache-Control': 'no-store',
  });
  createReadStream(artifact.filePath).pipe(response);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  let size = 0;
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    size += chunks[chunks.length - 1].length;
    if (size > 16_384) throw new PurchaseError('Request body too large', 413);
  }

  if (chunks.length === 0) {
    return {};
  }

  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new PurchaseError('Invalid JSON', 400); }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', env.DASHBOARD_ORIGIN);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({ level: 'error', message: 'Uncaught exception', error: error.message }));
});

process.on('unhandledRejection', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Unhandled rejection',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
});

export function normalizeApiError(error: unknown): { status: number; message: string } {
  if (error instanceof PurchaseError) return { status: error.status, message: error.message };
  if (error instanceof ZodError) {
    return { status: 400, message: error.issues.map((issue) => issue.message).join('; ') };
  }

  return { status: 500, message: error instanceof Error ? error.message : String(error) };
}
