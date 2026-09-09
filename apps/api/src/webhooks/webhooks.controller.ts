import { Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';

import type { Request } from 'express';
import { GithubSignatureGuard } from '../guards/signature.guard.js';
import { WebhooksService } from './webhooks.service.js';


@Controller('webhooks')
export class WebhooksController {

  constructor(private readonly webhooksService: WebhooksService){}


  @UseGuards(GithubSignatureGuard)
  @Post('github')
  @HttpCode(HttpStatus.OK)
  handleWebhook(@Req() req: RawBodyRequest<Request>) {
    const deliveryId = (req.headers['x-github-delivery'] as string) ?? 'unknown';
    const event = (req.headers['x-github-event'] as string) ?? 'unknown';


    return this.webhooksService.handleWebhook(deliveryId, event)
  }
}
