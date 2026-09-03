import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { GithubSignatureGuard } from './guards/GithubSignature.guard.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    })
      // The guard is not under test here, and pulling in the real one would drag
      // ConfigService (and a webhook secret) into a test about a greeting.
      // Signature verification is covered in guards/signature.guard.spec.ts.
      .overrideGuard(GithubSignatureGuard)
      .useValue({ canActivate: () => true })
      .compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});
