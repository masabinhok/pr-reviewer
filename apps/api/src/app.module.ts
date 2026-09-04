import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import {z} from 'zod';
import { HealthModule } from './health/health.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import configuration from './config/configuration.js';

@Module({
  imports: [ConfigModule.forRoot({
    load: [configuration],
    validationSchema: z.object({
      POSTGRES_USER: z.string(),
      POSTGRES_PASSWORD: z.string(),
      POSTGRES_DB: z.string(),
      PORT: z.coerce.number().default(3333),
      DATABASE_URL: z.url(),
      REDIS_URL: z.url(),
      GITHUB_APP_ID: z.string(),
      GITHUB_APP_CLIENT_ID: z.string(),
      GITHUB_WEBHOOK_SECRET: z.string(),
      GITHUB_APP_PRIVATE_KEY_BASE64: z.string(),
    }),
    envFilePath: '../../.env',
    isGlobal: true
  }), HealthModule, WebhooksModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
