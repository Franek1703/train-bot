import { AsyncLocalStorage } from 'node:async_hooks';

export interface CheckLogEntry {
  timestamp: string;
  level: 'info' | 'error';
  message: string;
  context: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<CheckLogEntry[]>();

export async function captureCheckLogs<T>(
  run: () => Promise<T>,
): Promise<{ result: T; entries: CheckLogEntry[] }> {
  const entries: CheckLogEntry[] = [];
  const result = await storage.run(entries, run);
  return { result, entries };
}

export function recordCheckLog(
  level: CheckLogEntry['level'],
  message: string,
  context: Record<string, unknown> = {},
): void {
  storage.getStore()?.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  });
}
