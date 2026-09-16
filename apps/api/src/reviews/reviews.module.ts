import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { PullRequestLock } from './pull-request-lock.js';
import { StaleFindings } from './stale-findings.service.js';
import { GithubModule } from '../github/github.module.js';
import { PullRequestsService } from './pull-requests.service.js';
import { ReviewProcessor } from './review.processor.js';
import { ReviewPipeline } from './review-pipeline.js';
import { REVIEWER } from '../reviewer/reviewer.js';
import { StubReviewer } from '../reviewer/stub-reviewer.js';
import { AgentReviewer } from '../reviewer/agent-reviewer.js';
import { ReviewerResultStore } from './reviewer-result.store.js';
import { ReviewPublisher } from './review-publisher.js';
import { ConfigService } from '@nestjs/config';
import { InstallationTokenService } from '../github/installation-token.service.js';

@Module({
  imports: [QueueModule, GithubModule, RedisModule],
  providers: [
    PullRequestsService,
    ReviewProcessor,
    ReviewPipeline,
    ReviewerResultStore,
    ReviewPublisher,
    PullRequestLock,
    StaleFindings,
    // The agent when it is configured, the stub otherwise (see agent.reviewer in the config).
    // A factory, not two providers: AgentReviewer refuses to construct without its settings,
    // which is right when it is selected and wrong when it is not.
    {
      provide: REVIEWER,
      inject: [ConfigService, InstallationTokenService],
      useFactory: (config: ConfigService, tokens: InstallationTokenService) =>
        config.get<string>('agent.reviewer') === 'agent' ? new AgentReviewer(config, tokens) : new StubReviewer(),
    },
  ],
  exports: [PullRequestsService, StaleFindings],
})
export class ReviewsModule {}
