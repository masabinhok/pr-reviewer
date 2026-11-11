import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

describe('HealthService', () => {
  let service: HealthService;
  const prisma = { $queryRaw: vi.fn() };
  const redis = { ping: vi.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('reports healthy when both checks succeed', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    const result = await service.check();

    expect(result).toEqual({
      healthy: true,
      checks: { db: 'up', redis: 'up' },
    });
  });

  it('reports unhealthy when a check fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');

    const result = await service.check();

    expect(result).toEqual({
      healthy: false,
      checks: { db: 'down', redis: 'up' },
    });
  });
});
