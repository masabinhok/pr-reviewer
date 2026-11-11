import type { NestExpressApplication } from '@nestjs/platform-express';

/** What main.ts sets on the app, shared with the e2e suites that build their own. */
export function configureApp(app: NestExpressApplication): void {
  app.enableShutdownHooks();
  app.disable('x-powered-by');
  // GitHub caps a delivery at 25 MB; Express's default 100 kB would 413 a large pull request.
  // With rawBody: true on the app, the raw bytes are still kept for the signature check.
  app.useBodyParser('json', { limit: '25mb' });
}
