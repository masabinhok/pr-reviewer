import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service.js';

/** Release only if the lock is still ours: it may have expired and been taken by another. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * One review of a pull request settles at a time.
 *
 * The worker runs two jobs at once, and two quick pushes to one PR make two reviews. Each
 * decides which of its findings were already commented on by looking at what earlier reviews
 * posted — so if both stored and posted at the same moment, neither would see the other's
 * comments, and the PR would get the same comment twice. Holding this lock from storing the
 * findings to posting them makes the second review see the first one's comments.
 *
 * A Redis lock with an expiry, so a worker that dies holding it only delays the PR, and a
 * token, so a lock that expired and was taken by another review is not released by the first.
 */
@Injectable()
export class PullRequestLock {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.prefix = config.getOrThrow<string>('queue.prefix');
  }

  /** A release function if the lock was free, or null if another review holds it. */
  async acquire(
    repo: string,
    prNumber: number,
    ttlMs = 120_000,
  ): Promise<(() => Promise<void>) | null> {
    const key = `${this.prefix}:settle:${repo}#${prNumber}`;
    const token = randomUUID();
    if ((await this.redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK')
      return null;
    return async () => {
      await this.redis.eval(RELEASE, 1, key, token);
    };
  }
}
