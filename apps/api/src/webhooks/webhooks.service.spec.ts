import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryStatus, Prisma } from '../generated/prisma/client.js';
import { InstallationsService } from '../installations/installations.service.js';
import { PullRequestsService } from '../reviews/pull-requests.service.js';

/**
 * The error Postgres produces when the unique constraint on deliveryId rejects a
 * second insert, as Prisma surfaces it. Building it by hand is what lets the unit
 * test exercise the duplicate path without a database — see the integration test
 * for the version that proves the constraint is really there.
 */
function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['deliveryId'] },
  });
}

/**
 * Only the two calls the service makes. `create` is what the constraint rejects;
 * `update` is the status bookkeeping that follows a successful insert.
 */
function prismaStub() {
  return {
    webhookDelivery: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

/** Every handler the dispatch table can route to, as spies. */
function installationsStub() {
  return {
    created: vi.fn().mockResolvedValue(undefined),
    deleted: vi.fn().mockResolvedValue(undefined),
    suspended: vi.fn().mockResolvedValue(undefined),
    unsuspended: vi.fn().mockResolvedValue(undefined),
    reposAdded: vi.fn().mockResolvedValue(undefined),
    reposRemoved: vi.fn().mockResolvedValue(undefined),
  };
}

describe('WebhooksService', () => {
  let service: WebhooksService;
  let prisma: ReturnType<typeof prismaStub>;
  let installations: ReturnType<typeof installationsStub>;
  let pullRequests: { handle: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = prismaStub();
    installations = installationsStub();
    pullRequests = { handle: vi.fn().mockResolvedValue('enqueued') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prisma },
        { provide: InstallationsService, useValue: installations },
        { provide: PullRequestsService, useValue: pullRequests },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);

    // The service logs on every path; keep the expected noise out of the output.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the delivery and reports it handled', async () => {
    const result = await service.handleWebhook('d-1', 'pull_request', { action: 'opened' });

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-1', event: 'pull_request', action: 'opened' },
    });
    expect(result).toEqual({ ok: true, handled: true });
  });

  // Pointing the stub at the P2002 error is how you make "the row already exists"
  // happen without a database.
  it('returns duplicate: true when the delivery id already exists', async () => {
    prisma.webhookDelivery.create.mockRejectedValue(uniqueViolation());

    const result = await service.handleWebhook('d-1', 'pull_request');

    expect(result).toEqual({ ok: true, duplicate: true });
  });

  // The return value alone cannot prove this: the shape above comes back whether or
  // not the handler also ran. Only the absence of the `update` call proves the skip.
  it('does not update the row when the delivery is a duplicate', async () => {
    prisma.webhookDelivery.create.mockRejectedValue(uniqueViolation());

    await service.handleWebhook('d-1', 'pull_request');

    expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
  });

  // 'issues' has no entry in the dispatch table, but the row is still written — every delivery
  // gets one — and then moved to its terminal status.
  it('records an unhandled event and marks it IGNORED', async () => {
    const result = await service.handleWebhook('d-2', 'issues', { action: 'opened' });

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-2', event: 'issues', action: 'opened' },
    });
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { deliveryId: 'd-2' },
      // `expect.any(Date)` matches the type without pinning the exact instant — the
      // service calls `new Date()` itself, so the test cannot know the value.
      data: { status: DeliveryStatus.IGNORED, processedAt: expect.any(Date), error: undefined },
    });
    expect(result).toEqual({ ok: true, handled: false });
  });

  it('marks a handled delivery PROCESSED', async () => {
    await service.handleWebhook('d-3', 'pull_request', { action: 'opened' });

    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { deliveryId: 'd-3' },
      data: { status: DeliveryStatus.PROCESSED, processedAt: expect.any(Date), error: undefined },
    });
  });

  // The counterpart to the duplicate test: everything that is NOT a unique-constraint
  // violation has to propagate. If this ever goes green by returning a value instead
  // of throwing, the service is swallowing real database failures.
  it('rethrows an error that is not a unique-constraint violation', async () => {
    prisma.webhookDelivery.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.handleWebhook('d-4', 'pull_request')).rejects.toThrow('connection lost');
    expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
  });

  // Some events (`push`, `ping`) carry no `action`. The column is nullable for them.
  it('records a null action when the payload has none', async () => {
    await service.handleWebhook('d-5', 'push', {});

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-5', event: 'push', action: null },
    });
  });

  describe('dispatch', () => {
    it.each([
      ['installation', 'created', 'created'],
      ['installation', 'deleted', 'deleted'],
      ['installation', 'suspend', 'suspended'],
      ['installation', 'unsuspend', 'unsuspended'],
      ['installation_repositories', 'added', 'reposAdded'],
      ['installation_repositories', 'removed', 'reposRemoved'],
    ] as const)('routes %s.%s to InstallationsService.%s', async (event, action, method) => {
      const payload = { action, installation: { id: 1 } };

      const result = await service.handleWebhook('d-6', event, payload);

      expect(installations[method]).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ ok: true, handled: true });
    });

    it.each(['opened', 'reopened', 'synchronize', 'ready_for_review'])(
      'routes pull_request.%s to PullRequestsService',
      async (action) => {
        const payload = { action, number: 1 };

        const result = await service.handleWebhook('d-9', 'pull_request', payload);

        expect(pullRequests.handle).toHaveBeenCalledWith(payload, 'd-9');
        expect(result).toEqual({ ok: true, handled: true });
      },
    );

    // Closing, labelling, editing a PR is not new code — nothing to review.
    it.each(['closed', 'labeled', 'edited'])('ignores pull_request.%s', async (action) => {
      const result = await service.handleWebhook('d-10', 'pull_request', { action });

      expect(result).toEqual({ ok: true, handled: false });
      expect(pullRequests.handle).not.toHaveBeenCalled();
    });

    // The key is event.action, so a known event with an unknown action is unhandled —
    // it must not fall into some other installation handler.
    it('ignores an action of a known event that has no handler', async () => {
      const result = await service.handleWebhook('d-7', 'installation', {
        action: 'new_permissions_accepted',
      });

      expect(result).toEqual({ ok: true, handled: false });
      expect(Object.values(installations).some((fn) => fn.mock.calls.length > 0)).toBe(false);
      expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: DeliveryStatus.IGNORED }) }),
      );
    });

    // A handler that throws must leave a FAILED row carrying the message, and the error
    // must still propagate — GitHub then sees a 500 and redelivers later.
    it('records FAILED with the error when a handler throws, then rethrows', async () => {
      installations.created.mockRejectedValue(new Error('database went away'));

      await expect(
        service.handleWebhook('d-8', 'installation', { action: 'created' }),
      ).rejects.toThrow('database went away');

      expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { deliveryId: 'd-8' },
        data: { status: DeliveryStatus.FAILED, processedAt: expect.any(Date), error: 'database went away' },
      });
    });
  });
});
