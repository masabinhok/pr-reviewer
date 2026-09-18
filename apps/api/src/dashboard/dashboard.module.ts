import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardTokenGuard } from './dashboard-token.guard.js';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, DashboardTokenGuard],
})
export class DashboardModule {}
