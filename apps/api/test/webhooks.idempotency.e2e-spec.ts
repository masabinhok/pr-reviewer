import { config } from 'dotenv';

config({ path: '../../.env' });

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WebhooksService } from '../src/webhooks/webhooks.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DeliveryStatus } from '../src/generated/prisma/client.js';
import { InstallationsService } from '../src/installations/installations.service.js';
import { PullRequestsService } from '../src/reviews/pull-requests.service.js';
import { StaleFindings } from '../src/reviews/stale-findings.service.js';

/**
 * The unit tests in src/webhooks/webhooks.service.spec.ts assert what the service does
 * when Prisma reports P2002. They cannot prove that Postgres actually reports it —
 * a fake returns whatever you told it to. These tests talk to the real database, so
 * they test the claim the whole milestone rests on: the unique constraint is the lock.
 *
 * Run with `npm run test:e2e` (needs `docker compose up -d`; runs against pr_reviewer_test).
 */

// Every row this file writes is prefixed, so cleanup deletes exactly its own rows and
// leaves the database as the next file expects to find it.
const PREFIX = 'itest-';
const uniqueId = () => `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const pullRequests = { handle: async () => 'enqueued' as const };

describe('WebhooksService idempotency (real database)', () => {
  let module: TestingModule;
  let service: WebhooksService;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      // Idempotency is decided before any handler runs; what the handlers do is tested
      // elsewhere. These stubs only satisfy the dependencies.
      providers: [
        WebhooksService,
        PrismaService,
        { provide: InstallationsService, useValue: {} },
        { provide: PullRequestsService, useValue: pullRequests },
        { provide: StaleFindings, useValue: { setResolvedByPerson: async () => 0 } },
      ],
    }).compile();

    // init() runs the lifecycle hooks, which is what calls PrismaService.$connect().
    // compile() alone builds the graph without starting anything.
    await module.init();

    service = module.get(WebhooksService);
    prisma = module.get(PrismaService);

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({ where: { deliveryId: { startsWith: PREFIX } } });
    await module.close();
    vi.restoreAllMocks();
  });

  it('writes exactly one row when the same delivery arrives twice', async () => {
    const deliveryId = uniqueId();

    const first = await service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' });
    const second = await service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' });

    expect(first).toEqual({ ok: true, handled: true });
    expect(second).toEqual({ ok: true, duplicate: true });

    const rows = await prisma.webhookDelivery.findMany({ where: { deliveryId } });
    expect(rows).toHaveLength(1);
  });

  it('leaves the original row untouched when a duplicate arrives', async () => {
    const deliveryId = uniqueId();

    await service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' });
    const afterFirst = await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });

    await service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' });
    const afterSecond = await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });

    // The first run's outcome is the record of what happened. A duplicate must not
    // overwrite it — including resetting processedAt to a later timestamp.
    expect(afterSecond.status).toBe(DeliveryStatus.PROCESSED);
    expect(afterSecond.processedAt).toEqual(afterFirst.processedAt);
  });

  // This is the test the milestone actually exists for. The two calls are in flight at
  // the same time, so neither can see the other's row — exactly the interleaving that
  // defeats check-then-insert. Only the database constraint can separate them.
  it('lets exactly one of two concurrent deliveries through', async () => {
    const deliveryId = uniqueId();

    const results = await Promise.all([
      service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' }),
      service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' }),
    ]);

    expect(results.filter((r) => 'duplicate' in r)).toHaveLength(1);
    expect(results.filter((r) => 'handled' in r)).toHaveLength(1);

    const rows = await prisma.webhookDelivery.findMany({ where: { deliveryId } });
    expect(rows).toHaveLength(1);
  });

  // GitHub's Redeliver button on a delivery whose handler failed must actually retry it —
  // and two concurrent redeliveries must still only retry it once.
  it('reprocesses a redelivery of a FAILED delivery exactly once, even under a race', async () => {
    const deliveryId = uniqueId();
    const handle = vi.spyOn(pullRequests, 'handle').mockRejectedValueOnce(new Error('Redis down'));

    await expect(
      service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' }),
    ).rejects.toThrow('Redis down');
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } })).status).toBe(
      DeliveryStatus.FAILED,
    );

    const results = await Promise.all([
      service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' }),
      service.handleWebhook(deliveryId, 'pull_request', { action: 'opened' }),
    ]);

    expect(results.filter((r) => 'duplicate' in r)).toHaveLength(1);
    expect(handle).toHaveBeenCalledTimes(2); // the failed first run, then exactly one retry
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(row.status).toBe(DeliveryStatus.PROCESSED);
    expect(row.error).toBeNull();
    handle.mockRestore();
  });

  it('records an unhandled event as IGNORED rather than dropping it', async () => {
    const deliveryId = uniqueId();

    await service.handleWebhook(deliveryId, 'issues', { action: 'opened' });

    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId } });
    expect(row.status).toBe(DeliveryStatus.IGNORED);
    expect(row.event).toBe('issues');
  });
});
