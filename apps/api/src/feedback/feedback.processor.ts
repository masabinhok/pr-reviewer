import { Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { FeedbackPoller, type PollSummary } from './feedback-poller.js';

export const FEEDBACK_QUEUE = 'feedback-poll';
const SCHEDULER_ID = 'poll-reactions';

/**
 * Runs the reactions poll on a schedule. A BullMQ job scheduler rather than a timer in the
 * process: Redis holds the schedule, so two API processes still poll once, and a round that
 * throws is logged like any failed job instead of vanishing.
 */
@Processor(FEEDBACK_QUEUE)
export class FeedbackProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(FeedbackProcessor.name);

  constructor(
    private readonly poller: FeedbackPoller,
    private readonly config: ConfigService,
    @InjectQueue(FEEDBACK_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const every = this.config.getOrThrow<number>('feedback.pollMs');
    if (every <= 0) {
      // Off (the e2e suite turns it off and polls by hand); remove a schedule left from before.
      await this.queue.removeJobScheduler(SCHEDULER_ID);
      return;
    }
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every },
      { name: 'poll', opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
    this.logger.log(`polling reactions every ${Math.round(every / 1000)}s`);
  }

  async process(_job: Job): Promise<PollSummary> {
    return this.poller.pollOnce();
  }
}
