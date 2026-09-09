import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryStatus, Prisma } from '../generated/prisma/client.js';

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

describe('WebhooksService', () => {
  let service: WebhooksService;
  let prisma: ReturnType<typeof prismaStub>;

  beforeEach(async () => {
    prisma = prismaStub();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: prisma },
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

  // ---- WORKED EXAMPLE: the happy path ----
  it('records the delivery and reports it handled', async () => {
    const result = await service.handleWebhook('d-1', 'pull_request');

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-1', event: 'pull_request' },
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

  // 'issues' is not in HANDLED_EVENTS, but the row is still written — every delivery
  // gets one — and then moved to its terminal status.
  it('records an unhandled event and marks it IGNORED', async () => {
    const result = await service.handleWebhook('d-2', 'issues');

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-2', event: 'issues' },
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
    await service.handleWebhook('d-3', 'pull_request');

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
});
