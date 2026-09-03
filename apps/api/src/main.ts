import { config } from 'dotenv';

config({ path: '../../.env' });

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true
  });
  app.enableShutdownHooks()
  const configService = app.get(ConfigService);
  await app.listen(configService.getOrThrow<number>('port'));
}
await bootstrap();
