import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryStatus, Prisma } from '../generated/prisma/client.js';
import { InstallationsService } from '../installations/installations.service.js';
import type {
  InstallationPayload,
  InstallationRepositoriesPayload,
} from '../installations/github-payloads.js';
import { PullRequestsService } from '../reviews/pull-requests.service.js';
import type { PullRequestPayload } from '../reviews/pull-request-payload.js';
import type { ReviewThreadPayload } from '../reviews/review-thread-payload.js';
import { StaleFindings } from '../reviews/stale-findings.service.js';

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
     * the endpoint unhealthy. New events are new rows here; nothing else in this class changes.
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
        // The actions that mean "there is new code to review". Every other pull_request
        // action (closed, labeled, edited, …) has no key, so it lands as IGNORED.
        'pull_request.opened': (p, id) => this.reviewPullRequest(p, id),
        'pull_request.reopened': (p, id) => this.reviewPullRequest(p, id),
        'pull_request.synchronize': (p, id) => this.reviewPullRequest(p, id),
        'pull_request.ready_for_review': (p, id) => this.reviewPullRequest(p, id),
        // Someone resolved or reopened one of the App's comment threads by hand. Their
        // decision about a finding outranks the App's.
        'pull_request_review_thread.resolved': (p) => this.threadResolution(p, true),
        'pull_request_review_thread.unresolved': (p) => this.threadResolution(p, false),
    }

    constructor(
        private readonly prisma: PrismaService,
        private readonly installations: InstallationsService,
        private readonly pullRequests: PullRequestsService,
        private readonly stale: StaleFindings,
    ){}

    private async threadResolution(payload: WebhookPayload, resolved: boolean): Promise<void> {
        const { thread } = payload as unknown as ReviewThreadPayload
        const ids = (thread?.comments ?? []).map((c) => BigInt(c.id))
        const count = await this.stale.setResolvedByPerson(ids, resolved)
        if (count > 0) {
            this.logger.log(`${count} finding(s) ${resolved ? 'resolved' : 'reopened'} — a person ${resolved ? 'resolved' : 'reopened'} the thread`)
        }
    }

    private async reviewPullRequest(payload: WebhookPayload, deliveryId: string): Promise<void> {
        await this.pullRequests.handle(payload as unknown as PullRequestPayload, deliveryId)
    }

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
            // A redelivery of a delivery that FAILED is a retry, not a duplicate — that is
            // what the Redeliver button is for. Reclaiming the row with a conditional
            // update keeps it race-safe: of two concurrent redeliveries, only one can flip
            // FAILED back to RECEIVED, and the other is dropped as a duplicate.
            if (!(await this.reclaimFailed(deliveryId))) {
                this.logger.log(`[${deliveryId}] duplicate delivery dropped`)
                return {
                    ok: true,
                    duplicate: true
                }
            }
            this.logger.log(`[${deliveryId}] redelivery of a FAILED delivery — processing it again`)
        } else {
            // Anything else is a real failure — never swallow it, or the row silently
            // disagrees with what actually happened.
            throw e
        }
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

    /** FAILED → RECEIVED, only if it is currently FAILED. True if this call won it. */
    private async reclaimFailed(deliveryId: string): Promise<boolean> {
        const { count } = await this.prisma.webhookDelivery.updateMany({
            where: { deliveryId, status: DeliveryStatus.FAILED },
            data: { status: DeliveryStatus.RECEIVED, error: null, processedAt: null }
        })
        return count === 1
    }

    /** Moves a delivery off RECEIVED to its terminal status. */
    private async finish(deliveryId: string, status: DeliveryStatus, error?: string){
        await this.prisma.webhookDelivery.update({
            where: { deliveryId },
            data: { status, processedAt: new Date(), error }
        })
    }
}
