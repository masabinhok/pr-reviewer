import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { REVIEW_QUEUE, reviewJobDefaults } from '../reviews/review-queue.js';

/**
 * BullMQ's connection to Redis. Deliberately *connection options*, not the app's
 * `RedisService` client: workers use blocking commands, and BullMQ refuses a client
 * whose `maxRetriesPerRequest` isn't null. Given plain options, it builds its own
 * connections and sets that itself.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('redis.url') },
        prefix: config.getOrThrow<string>('queue.prefix'),
      }),
    }),
    BullModule.registerQueue({ name: REVIEW_QUEUE, defaultJobOptions: reviewJobDefaults }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
