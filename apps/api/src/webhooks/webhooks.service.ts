import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryStatus, Prisma } from '../generated/prisma/client.js';


// Anything not listed here is acknowledged and dropped, never 500 — a 500 on an
// unhandled event makes GitHub mark the endpoint unhealthy.
const HANDLED_EVENTS = new Set(['pull_request']);

@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name)

    constructor(private readonly prisma: PrismaService){}

    async handleWebhook(deliveryId: string, event: string){

    // Record the delivery BEFORE deciding whether to handle it. Every delivery gets a
    // row — the insert is what makes redeliveries idempotent, handled or not — and the
    // unique constraint on deliveryId is the only thing that sees every writer at once.
    try {
        await this.prisma.webhookDelivery.create({
            data: {
                event,
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

    if (!HANDLED_EVENTS.has(event)) {
      this.logger.log(`[${deliveryId}] ignoring unhandled event "${event}"`);
      await this.finish(deliveryId, DeliveryStatus.IGNORED)
      return { ok: true, handled: false };
    }

    this.logger.log(`[${deliveryId}] accepted event "${event}"`);

    try {
        await this.dispatch(deliveryId, event)
        await this.finish(deliveryId, DeliveryStatus.PROCESSED)
    }
    catch(e){
        // Record the failure on the row before rethrowing. A delivery left at RECEIVED
        // forever is how you find out a handler died without saying so.
        const message = e instanceof Error ? e.message : String(e)
        this.logger.error(`[${deliveryId}] handler failed: ${message}`)
        await this.finish(deliveryId, DeliveryStatus.FAILED, message)
        throw e
    }

    return { ok: true, handled: true };
    }

    /**
     * The dispatch seam. Weeks 3-4 replace the body with a BullMQ enqueue; everything
     * around it — the insert, the status bookkeeping — stays exactly as it is.
     */
    private async dispatch(deliveryId: string, event: string){
        this.logger.log(`[${deliveryId}] dispatching "${event}"`)
    }

    /** Moves a delivery off RECEIVED to its terminal status. */
    private async finish(deliveryId: string, status: DeliveryStatus, error?: string){
        await this.prisma.webhookDelivery.update({
            where: { deliveryId },
            data: { status, processedAt: new Date(), error }
        })
    }
}
