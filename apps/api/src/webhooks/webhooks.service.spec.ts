import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

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

  // ---- YOUR TURN ----
  // `uniqueViolation()` above builds the P2002 error. To make an insert fail, point
  // the stub at it: prisma.webhookDelivery.create.mockRejectedValue(uniqueViolation()).
  // Assert on the mocks, not just the return value — "the handler did not run" is the
  // claim that matters, and only `update` (or a dispatch spy) can tell you that.

  // Insert rejects with P2002 => { ok: true, duplicate: true }.
  it.todo('returns duplicate: true when the delivery id already exists');

  // Same setup. A duplicate must not touch the row again — the original row's status
  // is the record of what actually happened, and overwriting it destroys that.
  it.todo('does not update the row when the delivery is a duplicate');

  // 'issues' is not in HANDLED_EVENTS. The row is still written (every delivery gets
  // one), then moved to IGNORED. Check the status passed to `update`.
  it.todo('records an unhandled event and marks it IGNORED');

  // A pull_request that succeeds should end at PROCESSED with processedAt set.
  it.todo('marks a handled delivery PROCESSED');

  // Reject the insert with a plain `new Error('connection lost')` instead. It must
  // propagate — the whole point of the `throw e` is that non-P2002 is never swallowed.
  it.todo('rethrows an error that is not a unique-constraint violation');
});
