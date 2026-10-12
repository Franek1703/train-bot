import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { getPurchaseSummaryArtifactId } from '../src/artifacts/artifactRepository.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Purchase summary screenshot association in PostgreSQL', () => {
  const watchIds: string[] = [];
  beforeAll(() => {
    const testUrl = process.env.TEST_DATABASE_URL!;
    if (process.env.DATABASE_URL !== testUrl || !new URL(testUrl).pathname.endsWith('_blik_test')) {
      throw new Error('DATABASE_URL must equal TEST_DATABASE_URL and use a dedicated *_blik_test database');
    }
  });
  afterEach(async () => { await prisma.watch.deleteMany({ where: { id: { in: watchIds } } }); watchIds.length = 0; });
  afterAll(async () => { await prisma.$disconnect(); });

  it('returns only the summary of this purchase, even when other attempts and page screenshots are newer', async () => {
    const watch = await prisma.watch.create({ data: {
      configKey: `summary-test-${randomUUID()}`, origin: 'Poznań', destination: 'Warszawa', travelDate: new Date('2026-10-11'),
    } });
    watchIds.push(watch.id);
    const check = await prisma.availabilityCheck.create({ data: { watchId: watch.id, status: 'AVAILABLE_WITH_SEAT', available: true } });
    const otherCheck = await prisma.availabilityCheck.create({ data: { watchId: watch.id, status: 'AVAILABLE_WITH_SEAT', available: true } });
    const artifact = (checkId: string, label: string, kind = 'screenshot') => prisma.watchArtifact.create({ data: {
      watchId: watch.id, availabilityCheckId: checkId, kind, label, filePath: '/unused-test-path', contentType: 'image/png',
    } });
    await artifact(otherCheck.id, 'summary-1.png');
    await artifact(check.id, 'list-2.png');
    await artifact(check.id, 'summary-3.png', 'log');
    expect(await getPurchaseSummaryArtifactId(watch.id, null)).toBeNull();
    expect(await getPurchaseSummaryArtifactId(watch.id, check.id)).toBeNull();
    const summary = await artifact(check.id, 'summary-4.png');
    await artifact(check.id, 'cart-5.png');
    await artifact(otherCheck.id, 'summary-6.png');
    expect(await getPurchaseSummaryArtifactId(watch.id, check.id)).toBe(summary.id);
    expect(await getPurchaseSummaryArtifactId(randomUUID(), check.id)).toBeNull();
  });
});
