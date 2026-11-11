import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { InstallationsService } from '../src/installations/installations.service.js';
import { DeliveryStatus } from '../src/generated/prisma/client.js';
import type { InstallationPayload } from '../src/installations/github-payloads.js';
import { sign } from './helpers/sign.js';
import { fixture, fixtureJson } from './helpers/fixtures.js';
import { truncateAll } from './helpers/db.js';

/**
 * The whole webhook path over real HTTP: raw-body capture, signature guard, controller,
 * idempotency, dispatch, handlers, Postgres. Payloads are real captured deliveries
 * (test/fixtures, via `npm run capture:fixtures`), sent byte-for-byte.
 */
describe('POST /webhooks/github (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Same option main.ts passes to NestFactory. Without it req.rawBody is undefined and
    // every request 401s — which is exactly what this suite would then catch.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    prisma = app.get(PrismaService);

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  /** POSTs `body` exactly as given, signed correctly unless the test says otherwise. */
  function deliver(
    event: string,
    body: string,
    options: { deliveryId?: string; signature?: string | null } = {},
  ) {
    const req = request(app.getHttpServer())
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', options.deliveryId ?? randomUUID());

    if (options.signature !== null) {
      req.set('X-Hub-Signature-256', options.signature ?? sign(body));
    }
    return req.send(body);
  }

  const deliveryCount = () => prisma.webhookDelivery.count();

  describe('signature verification', () => {
    const body = fixture('pull_request.opened');

    it('accepts a correctly signed delivery', async () => {
      const deliveryId = randomUUID();

      await deliver('pull_request', body, { deliveryId })
        .expect(200)
        .expect({ ok: true, handled: true });

      const row = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { deliveryId },
      });
      expect(row).toMatchObject({
        event: 'pull_request',
        action: 'opened',
        status: DeliveryStatus.PROCESSED,
      });
    });

    it('rejects a signature made with the wrong secret, and writes nothing', async () => {
      await deliver('pull_request', body, {
        signature: sign(body, 'not-the-secret'),
      }).expect(401);

      expect(await deliveryCount()).toBe(0);
    });

    // Sign the real bytes, then change one of them. This is the case that catches a guard
    // verifying against the parsed-and-reserialised JSON instead of the raw body.
    it('rejects a body altered after signing, and writes nothing', async () => {
      const tampered = body.replace('"action": "opened"', '"action": "closed"');
      expect(tampered).not.toBe(body);

      await deliver('pull_request', tampered, { signature: sign(body) }).expect(
        401,
      );

      expect(await deliveryCount()).toBe(0);
    });

    it('rejects a delivery with no signature header', async () => {
      await deliver('pull_request', body, { signature: null }).expect(401);
    });

    // Wrong length is the case that used to crash timingSafeEqual into a 500.
    it('rejects a malformed signature with a 401, not a 500', async () => {
      await deliver('pull_request', body, { signature: 'sha256=abc' }).expect(
        401,
      );
    });
  });

  describe('idempotency', () => {
    it('processes a redelivered installation.created exactly once', async () => {
      const body = fixture('installation.created');
      const deliveryId = randomUUID();
      const created = vi.spyOn(app.get(InstallationsService), 'created');

      await deliver('installation', body, { deliveryId })
        .expect(200)
        .expect({ ok: true, handled: true });
      await deliver('installation', body, { deliveryId })
        .expect(200)
        .expect({ ok: true, duplicate: true });

      expect(created).toHaveBeenCalledTimes(1);
      expect(await deliveryCount()).toBe(1);
      expect(await prisma.installation.count()).toBe(1);

      created.mockRestore();
    });
  });

  describe('installation lifecycle', () => {
    it('installation.created records the installation and its repositories', async () => {
      const payload = fixtureJson<InstallationPayload>('installation.created');

      await deliver('installation', fixture('installation.created')).expect(
        200,
      );

      const installation = await prisma.installation.findUniqueOrThrow({
        where: { githubId: BigInt(payload.installation.id) },
        include: { repos: true },
      });
      expect(installation.accountLogin).toBe(
        payload.installation.account.login,
      );
      expect(installation.deletedAt).toBeNull();
      expect(installation.repos.map((r) => r.fullName).sort()).toEqual(
        (payload.repositories ?? []).map((r) => r.full_name).sort(),
      );
    });

    it('installation.deleted soft deletes, and every row is still there', async () => {
      const deleted = fixtureJson<InstallationPayload>('installation.deleted');

      // Seed the same installation the real deletion refers to. After a reinstall GitHub
      // may use a new installation ID, so the captured `created` may not match this one.
      const seed = JSON.stringify({ ...deleted, action: 'created' });
      await deliver('installation', seed).expect(200);
      const reposBefore = await prisma.repo.count();

      await deliver('installation', fixture('installation.deleted')).expect(
        200,
      );

      const installation = await prisma.installation.findUniqueOrThrow({
        where: { githubId: BigInt(deleted.installation.id) },
        include: { repos: true },
      });
      expect(installation.deletedAt).toBeInstanceOf(Date);
      expect(installation.repos).toHaveLength(reposBefore);
      expect(installation.repos.every((r) => r.deletedAt instanceof Date)).toBe(
        true,
      );
    });
  });

  describe('events nothing handles', () => {
    it('acknowledges an unknown event with a 2xx and records it as IGNORED', async () => {
      const deliveryId = randomUUID();

      await deliver('check_suite', fixture('check_suite.requested'), {
        deliveryId,
      })
        .expect(200)
        .expect({ ok: true, handled: false });

      const row = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { deliveryId },
      });
      expect(row.status).toBe(DeliveryStatus.IGNORED);
    });
  });
});
