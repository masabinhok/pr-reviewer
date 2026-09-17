import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { FeedbackProcessor } from './feedback.processor.js';
import type { FeedbackPoller } from './feedback-poller.js';

describe('FeedbackProcessor', () => {
  const make = (pollMs: number) => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined), removeJobScheduler: vi.fn().mockResolvedValue(true) };
    const poller = { pollOnce: vi.fn().mockResolvedValue({ checked: 0 }) };
    const config = { getOrThrow: () => pollMs } as unknown as ConfigService;
    return { queue, poller, processor: new FeedbackProcessor(poller as unknown as FeedbackPoller, config, queue as unknown as Queue) };
  };

  beforeEach(() => vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('schedules the poll in Redis, so several processes still poll once', async () => {
    const { queue, processor } = make(300_000);

    await processor.onModuleInit();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith('poll-reactions', { every: 300_000 }, expect.objectContaining({ name: 'poll' }));
  });

  it('removes the schedule when polling is turned off', async () => {
    const { queue, processor } = make(0);

    await processor.onModuleInit();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('poll-reactions');
  });

  it('polls when the scheduled job runs', async () => {
    const { poller, processor } = make(300_000);

    await processor.process({} as never);

    expect(poller.pollOnce).toHaveBeenCalledTimes(1);
  });
});
