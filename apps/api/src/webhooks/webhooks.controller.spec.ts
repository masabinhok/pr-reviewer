import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller.js';
import { GithubSignatureGuard } from '../guards/signature.guard.js';
import { Logger } from '@nestjs/common';
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
    })
      // The guard is not under test here, and instantiating the real one would drag
      // ConfigService (and a webhook secret) into a test about event dispatch.
      // Signature verification is covered in guards/signature.guard.spec.ts.
      .overrideGuard(GithubSignatureGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WebhooksController>(WebhooksController);

    // The handler logs on every path; keep the expected noise out of the output.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns handled: true for a pull_request event', ()=> {
    expect(controller.handleWebhook(requestFor('pull_request'))).toEqual({
      ok: true, 
      handled: true
    })
  })

  it('returns handled: false for an unhandled event', ()=> {
    expect(controller.handleWebhook(requestFor('issues'))).toEqual({
      ok: true, 
      handled: false
    })
  })

  it('returns handled: false when the event header is missing', ()=> {
    expect(controller.handleWebhook(requestFor())).toEqual({
      ok: true, 
      handled: false
    })
  })
});
