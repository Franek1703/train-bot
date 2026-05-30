import type { WatchError } from '@prisma/client';
import { prisma } from '../db/client.js';

export async function listErrors(): Promise<WatchError[]> {
  return prisma.watchError.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getErrorById(errorId: string): Promise<WatchError | null> {
  return prisma.watchError.findUnique({
    where: { id: errorId },
  });
}
