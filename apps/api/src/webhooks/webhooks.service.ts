import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryStatus, Prisma } from '../generated/prisma/client.js';
import { InstallationsService } from '../installations/installations.service.js';
import type {
  InstallationPayload,
  InstallationRepositoriesPayload,
} from '../installations/github-payloads.js';

/** The parsed JSON body of a delivery. Only `action` is common to (most) events. */
export type WebhookPayload = { action?: unknown } & Record<string, unknown>;

type Handler = (payload: WebhookPayload, deliveryId: string) => Promise<void>;

@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name)

    /**
     * Dispatch table. Keys are `event.action` for events whose actions need different
     * handling, or a bare `event` to catch every action of it. Anything with no entry is
     * acknowledged and recorded as IGNORED — never a 500, which would make GitHub mark
     * the endpoint unhealthy. Week 3 adds rows here; nothing else in this class changes.
     */
    private readonly handlers: Record<string, Handler> = {
        'installation.created': (p) => this.installations.created(p as unknown as InstallationPayload),
        'installation.deleted': (p) => this.installations.deleted(p as unknown as InstallationPayload),
        'installation.suspend': (p) => this.installations.suspended(p as unknown as InstallationPayload),
        'installation.unsuspend': (p) => this.installations.unsuspended(p as unknown as InstallationPayload),
        'installation_repositories.added': (p) =>
            this.installations.reposAdded(p as unknown as InstallationRepositoriesPayload),
        'installation_repositories.removed': (p) =>
            this.installations.reposRemoved(p as unknown as InstallationRepositoriesPayload),
        // Placeholder until week 3's review pipeline: accepted and recorded, no work yet.
        'pull_request': async (_p, deliveryId) => {
            this.logger.log(`[${deliveryId}] pull_request accepted; reviewing lands in week 3`)
        },
    }

    constructor(
        private readonly prisma: PrismaService,
        private readonly installations: InstallationsService,
    ){}

    async handleWebhook(deliveryId: string, event: string, payload: WebhookPayload = {}){
    const action = typeof payload.action === 'string' ? payload.action : null

    // Record the delivery BEFORE deciding whether to handle it. Every delivery gets a
    // row — the insert is what makes redeliveries idempotent, handled or not — and the
    // unique constraint on deliveryId is the only thing that sees every writer at once.
    try {
        await this.prisma.webhookDelivery.create({
            data: {
                event,
                action,
                deliveryId,
            }
        })
    }
    catch(e){
        if(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'){
            this.logger.log(`[${deliveryId}] duplicate delivery dropped`)
            return {
                ok: true,
                duplicate: true
            }
        }
        // Anything else is a real failure — never swallow it, or the row silently
        // disagrees with what actually happened.
        throw e
    }

    const name = action ? `${event}.${action}` : event
    const handler = this.handlerFor(event, action)

    if (!handler) {
      this.logger.log(`[${deliveryId}] ignoring unhandled event "${name}"`);
      await this.finish(deliveryId, DeliveryStatus.IGNORED)
      return { ok: true, handled: false };
    }

    this.logger.log(`[${deliveryId}] accepted event "${name}"`);

    try {
        await handler(payload, deliveryId)
        await this.finish(deliveryId, DeliveryStatus.PROCESSED)
    }
    catch(e){
        // Record the failure on the row before rethrowing. A delivery left at RECEIVED
        // forever is how you find out a handler died without saying so.
        const message = e instanceof Error ? e.message : String(e)
        this.logger.error(`[${deliveryId}] handler for "${name}" failed: ${message}`)
        await this.finish(deliveryId, DeliveryStatus.FAILED, message)
        throw e
    }

    return { ok: true, handled: true };
    }

    /** Most specific wins: `installation.created` before a catch-all `installation`. */
    private handlerFor(event: string, action: string | null): Handler | undefined {
        return (action ? this.handlers[`${event}.${action}`] : undefined) ?? this.handlers[event]
    }

    /** Moves a delivery off RECEIVED to its terminal status. */
    private async finish(deliveryId: string, status: DeliveryStatus, error?: string){
        await this.prisma.webhookDelivery.update({
            where: { deliveryId },
            data: { status, processedAt: new Date(), error }
        })
    }
}
