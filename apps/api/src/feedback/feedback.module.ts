import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GithubModule } from '../github/github.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { FeedbackPoller } from './feedback-poller.js';
import { FEEDBACK_QUEUE, FeedbackProcessor } from './feedback.processor.js';

@Module({
  imports: [
    QueueModule,
    GithubModule,
    BullModule.registerQueue({ name: FEEDBACK_QUEUE }),
  ],
  providers: [FeedbackPoller, FeedbackProcessor],
  exports: [FeedbackPoller],
})
export class FeedbackModule {}
