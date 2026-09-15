import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service.js';
import { PullRequestLock } from '../src/reviews/pull-request-lock.js';

/** The settle lock against real Redis (database 1): the release script is the part to trust. */
describe('PullRequestLock (e2e, Redis)', () => {
  let redis: RedisService;
  let lock: PullRequestLock;

  beforeAll(() => {
    redis = new RedisService();
    lock = new PullRequestLock(redis, { getOrThrow: () => 'pr-reviewer-test' } as unknown as ConfigService);
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys('pr-reviewer-test:settle:*');
    if (keys.length) await redis.del(...keys);
  });

  it('lets one review of a pull request settle at a time', async () => {
    const release = await lock.acquire('octo/widgets', 3);

    expect(release).not.toBeNull();
    expect(await lock.acquire('octo/widgets', 3)).toBeNull();
    expect(await lock.acquire('octo/widgets', 4)).not.toBeNull(); // another PR is not blocked

    await release!();
    expect(await lock.acquire('octo/widgets', 3)).not.toBeNull();
  });

  it('frees itself when a holder dies without releasing', async () => {
    await lock.acquire('octo/widgets', 3, 50);

    await new Promise((r) => setTimeout(r, 80));

    expect(await lock.acquire('octo/widgets', 3)).not.toBeNull();
  });

  // A holder whose lock expired and was taken by another review must not release that one's.
  it('does not let a late release free a lock someone else now holds', async () => {
    const lateRelease = await lock.acquire('octo/widgets', 3, 50);
    await new Promise((r) => setTimeout(r, 80));
    const current = await lock.acquire('octo/widgets', 3);
    expect(current).not.toBeNull();

    await lateRelease!();

    expect(await lock.acquire('octo/widgets', 3)).toBeNull();
  });
});
