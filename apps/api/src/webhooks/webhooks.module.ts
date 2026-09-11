import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { InstallationsModule } from '../installations/installations.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';

@Module({
  imports: [InstallationsModule, ReviewsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
