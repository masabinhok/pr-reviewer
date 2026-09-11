import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { GithubModule } from '../github/github.module.js';
import { PullRequestsService } from './pull-requests.service.js';
import { ReviewProcessor } from './review.processor.js';
import { ReviewPipeline } from './review-pipeline.js';
import { REVIEWER } from '../reviewer/reviewer.js';
import { StubReviewer } from '../reviewer/stub-reviewer.js';

@Module({
  imports: [QueueModule, GithubModule],
  providers: [
    PullRequestsService,
    ReviewProcessor,
    ReviewPipeline,
    // Weeks 5–6 swap this one line for the agent.
    { provide: REVIEWER, useClass: StubReviewer },
  ],
  exports: [PullRequestsService],
})
export class ReviewsModule {}
