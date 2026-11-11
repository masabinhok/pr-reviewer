import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';
import { DashboardTokenGuard } from './dashboard-token.guard.js';
import { JsonSafeInterceptor } from './json-safe.js';

/**
 * The dashboard's API: read-only, behind a bearer token, JSON-safe. The dashboard (apps/web)
 * calls it from its server, never from a browser — so there is no CORS to configure, and the
 * token never reaches a page.
 */
@Controller('api/dashboard')
@UseGuards(DashboardTokenGuard)
@UseInterceptors(JsonSafeInterceptor)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  overview() {
    return this.dashboard.overview();
  }

  @Get('installations')
  installations() {
    return this.dashboard.installations();
  }

  @Get('reviews')
  reviews(
    @Query('repo') repo?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboard.reviews({
      repo,
      status,
      cursor,
      limit: limit ? Number(limit) || undefined : undefined,
    });
  }

  @Get('reviews/:id')
  review(@Param('id') id: string) {
    return this.dashboard.review(id);
  }
}
