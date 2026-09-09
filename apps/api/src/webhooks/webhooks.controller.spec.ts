import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { GithubSignatureGuard } from '../guards/signature.guard.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Builds the smallest request the handler can work with. It only reads the two
 * headers below — the guard has already checked rawBody by the time it runs.
 * Omit `event` to simulate a POST with no x-github-event header at all.
 */
function requestFor(event?: string){
  const headers: Record<string, string> = {
    'x-github-delivery': 'test-delivery-id',
  };

  if (event) headers['x-github-event'] = event;

  return {headers} as unknown as RawBodyRequest<Request>;
}

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let handleWebhook: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // The controller's whole job is now "read two headers, hand them to the service".
    // A spy is enough to test that, and it keeps Prisma out of a routing test —
    // the dispatch and idempotency rules are covered in webhooks.service.spec.ts.
    handleWebhook = vi.fn().mockResolvedValue({ ok: true, handled: true });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: { handleWebhook } }],
    })
      // The guard is not under test here, and instantiating the real one would drag
      // ConfigService (and a webhook secret) into a test about event dispatch.
      // Signature verification is covered in guards/signature.guard.spec.ts.
      .overrideGuard(GithubSignatureGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('passes the delivery id and event through to the service', async ()=> {
    await controller.handleWebhook(requestFor('pull_request'))

    expect(handleWebhook).toHaveBeenCalledWith('test-delivery-id', 'pull_request')
  })

  it('returns whatever the service returns', async ()=> {
    handleWebhook.mockResolvedValue({ ok: true, duplicate: true })

    await expect(controller.handleWebhook(requestFor('pull_request'))).resolves.toEqual({
      ok: true,
      duplicate: true
    })
  })

  it('falls back to "unknown" when the event header is missing', async ()=> {
    await controller.handleWebhook(requestFor())

    expect(handleWebhook).toHaveBeenCalledWith('test-delivery-id', 'unknown')
  })
});
