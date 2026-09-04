import { Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';

import type { Request } from 'express';
import { GithubSignatureGuard } from '../guards/signature.guard.js';

// Anything not listed here is acknowledged and dropped, never 500 — a 500 on an
// unhandled event makes GitHub mark the endpoint unhealthy.
const HANDLED_EVENTS = new Set(['pull_request']);


@Controller('webhooks')
export class WebhooksController {

  private readonly logger = new Logger(WebhooksController.name);

  @UseGuards(GithubSignatureGuard)
  @Post('github')
  @HttpCode(HttpStatus.OK)
  handleWebhook(@Req() req: RawBodyRequest<Request>) {
    const deliveryId = (req.headers['x-github-delivery'] as string) ?? 'unknown';
    const event = (req.headers['x-github-event'] as string) ?? 'unknown';

    if (!HANDLED_EVENTS.has(event)) {
      this.logger.log(`[${deliveryId}] ignoring unhandled event "${event}"`);
      return { ok: true, handled: false };
    }

    // ACK first — GitHub times out at ~10s. Weeks 3-4 replace this with a BullMQ
    // enqueue; the dispatch stays after the response either way.
    this.logger.log(`[${deliveryId}] accepted event "${event}"`);

    return { ok: true, handled: true };
  }
}
