import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  let controller: HealthController;
  const healthService = { check: vi.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns 200-shaped body when healthy', async () => {
    healthService.check.mockResolvedValue({
      healthy: true,
      checks: { db: 'up', redis: 'up' },
    });

    await expect(controller.getHealth()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up' },
    });
  });

  it('throws ServiceUnavailableException when unhealthy', async () => {
    healthService.check.mockResolvedValue({
      healthy: false,
      checks: { db: 'down', redis: 'up' },
    });

    await expect(controller.getHealth()).rejects.toMatchObject({ status: 503 });
  });
});
