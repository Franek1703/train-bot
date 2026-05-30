import type { WatchArtifact } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';

export async function getArtifactById(artifactId: string): Promise<WatchArtifact | null> {
  return prisma.watchArtifact.findUnique({
    where: { id: artifactId },
  });
}

export async function createArtifactRecord(args: {
  watchId: string;
  availabilityCheckId?: string;
  kind: string;
  label?: string;
  filePath: string;
  contentType: string;
}): Promise<WatchArtifact> {
  return prisma.watchArtifact.create({
    data: {
      watchId: args.watchId,
      availabilityCheckId: args.availabilityCheckId,
      kind: args.kind,
      label: args.label,
      filePath: args.filePath,
      contentType: args.contentType,
    },
  });
}

export async function writeTextArtifact(args: {
  watchId: string;
  availabilityCheckId?: string;
  kind: string;
  label: string;
  fileName: string;
  content: string;
  contentType: string;
}): Promise<WatchArtifact> {
  const directory = path.join(env.ARTIFACTS_DIR, args.watchId);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, args.fileName);
  await writeFile(filePath, args.content, 'utf8');

  return createArtifactRecord({
    watchId: args.watchId,
    availabilityCheckId: args.availabilityCheckId,
    kind: args.kind,
    label: args.label,
    filePath,
    contentType: args.contentType,
  });
}

export function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }

  if (filePath.endsWith('.jsonl')) {
    return 'application/x-ndjson; charset=utf-8';
  }

  return 'text/plain; charset=utf-8';
}
