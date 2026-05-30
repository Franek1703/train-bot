import type { WatchArtifact } from '@prisma/client';
import { prisma } from '../db/client.js';

export async function getArtifactById(artifactId: string): Promise<WatchArtifact | null> {
  return prisma.watchArtifact.findUnique({
    where: { id: artifactId },
  });
}
