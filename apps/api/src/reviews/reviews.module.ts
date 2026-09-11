import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { GithubModule } from '../github/github.module.js';
import { PullRequestsService } from './pull-requests.service.js';
import { ReviewProcessor } from './review.processor.js';

@Module({
  imports: [QueueModule, GithubModule],
  providers: [PullRequestsService, ReviewProcessor],
  exports: [PullRequestsService],
})
export class ReviewsModule {}
