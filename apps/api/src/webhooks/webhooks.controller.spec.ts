import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller.js';
import { GithubSignatureGuard } from '../guards/signature.guard.js';

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
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
