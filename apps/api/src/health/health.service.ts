import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export type Checks = Record<'db' | 'redis', 'up' | 'down'>;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<{ healthy: boolean; checks: Checks }> {
    const checks: Checks = { db: 'down', redis: 'down' };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.db = 'up';
    } catch {
      checks.db = 'down';
    }

    try {
      await this.redis.ping()
      checks.redis = 'up';
    } catch {
      checks.redis = 'down';
    }

    return { healthy: checks.db === 'up' && checks.redis === 'up', checks };
  }
}
