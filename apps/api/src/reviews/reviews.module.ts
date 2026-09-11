import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { PullRequestsService } from './pull-requests.service.js';
import { ReviewProcessor } from './review.processor.js';

@Module({
  imports: [QueueModule],
  providers: [PullRequestsService, ReviewProcessor],
  exports: [PullRequestsService],
})
export class ReviewsModule {}
