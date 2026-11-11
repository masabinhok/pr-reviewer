import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // No database or Redis call: an uptime ping here must not keep a scale-to-zero database awake.
  @Get()
  getRoot() {
    return { name: 'pr-reviewer', health: '/healthz' };
  }

  @Get('healthz')
  async getHealth() {
    const { healthy, checks } = await this.healthService.check();

    if (!healthy) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}
