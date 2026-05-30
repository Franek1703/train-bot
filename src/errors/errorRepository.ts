import { prisma } from '../db/client.js';

export async function listErrors() {
  return prisma.watchError.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { watch: true },
  });
}

export async function getErrorById(errorId: string) {
  return prisma.watchError.findUnique({
    where: { id: errorId },
    include: {
      watch: true,
      availabilityCheck: true,
    },
  });
}

export async function createWatchError(args: {
  watchId: string;
  availabilityCheckId: string;
  status: string;
  message: string;
  currentUrl?: string;
  pageTitle?: string;
  bodyPreview?: string;
  logArtifactId?: string;
  screenshotArtifactId?: string;
  diagnosticArtifactId?: string;
}) {
  return prisma.watchError.create({
    data: {
      watchId: args.watchId,
      availabilityCheckId: args.availabilityCheckId,
      status: args.status,
      message: args.message,
      currentUrl: args.currentUrl,
      pageTitle: args.pageTitle,
      bodyPreview: args.bodyPreview,
      logArtifactId: args.logArtifactId,
      screenshotArtifactId: args.screenshotArtifactId,
      diagnosticArtifactId: args.diagnosticArtifactId,
    },
  });
}
