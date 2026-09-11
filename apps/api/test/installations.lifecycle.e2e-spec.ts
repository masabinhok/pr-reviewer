import { config } from 'dotenv';

config({ path: '../../.env' });

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { InstallationsService } from '../src/installations/installations.service.js';
import { InstallationTokenService } from '../src/github/installation-token.service.js';
import { ReviewStatus } from '../src/generated/prisma/client.js';
import type { InstallationPayload } from '../src/installations/github-payloads.js';

/**
 * The install → uninstall → reinstall cycle against real Postgres. The property under
 * test is the product one: a repo's review history must survive an uninstall and be
 * reachable again after a reinstall — whichever installation ID GitHub hands back.
 */

// GitHub IDs far above anything real, so these rows can never collide with a captured
// fixture's installation, and cleanup can find exactly its own rows.
const base = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
const ids = { installation: base, reinstalled: base + 1, repoA: base + 2, repoB: base + 3 };

function installationEvent(
  action: string,
  installationId: number,
  repos: { id: number; name: string }[] = [],
): InstallationPayload {
  return {
    action,
    installation: { id: installationId, account: { login: 'itest-owner', type: 'User' } },
    repositories: repos.map((r) => ({ id: r.id, full_name: `itest-owner/${r.name}-${base}`, private: true })),
  };
}

const repoA = { id: ids.repoA, name: 'alpha' };
const repoB = { id: ids.repoB, name: 'beta' };

describe('Installation lifecycle (real database)', () => {
  let module: TestingModule;
  let service: InstallationsService;
  let prisma: PrismaService;
  const invalidate = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        InstallationsService,
        PrismaService,
        // Token eviction is Redis's business; here it only needs to be observable.
        { provide: InstallationTokenService, useValue: { invalidate } },
      ],
    }).compile();
    await module.init();

    service = module.get(InstallationsService);
    prisma = module.get(PrismaService);

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    const repoIds = [BigInt(ids.repoA), BigInt(ids.repoB)];
    await prisma.review.deleteMany({ where: { repo: { githubId: { in: repoIds } } } });
    await prisma.repo.deleteMany({ where: { githubId: { in: repoIds } } });
    await prisma.installation.deleteMany({
      where: { githubId: { in: [BigInt(ids.installation), BigInt(ids.reinstalled)] } },
    });
    await module.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => invalidate.mockClear());

  const installationRow = (githubId: number) =>
    prisma.installation.findUniqueOrThrow({ where: { githubId: BigInt(githubId) } });
  const repoRow = (githubId: number) =>
    prisma.repo.findUniqueOrThrow({ where: { githubId: BigInt(githubId) }, include: { reviews: true } });

  // The steps below share state on purpose: each one is the next event in one real
  // lifecycle, and the assertions are about what that sequence leaves behind.

  it('install: records the installation and its repositories', async () => {
    await service.created(installationEvent('created', ids.installation, [repoA, repoB]));

    const installation = await installationRow(ids.installation);
    expect(installation.deletedAt).toBeNull();
    expect(installation.accountLogin).toBe('itest-owner');

    const repo = await repoRow(ids.repoA);
    expect(repo.installationId).toBe(installation.id);
    expect(repo.defaultBranch).toBeNull(); // installation payloads do not carry it

    // Stand-in for week 3: a review now hangs off this repo. It is what must survive.
    await prisma.review.create({
      data: { repoId: repo.id, prNumber: 1, baseSha: 'base123', headSha: 'abc123', status: ReviewStatus.COMPLETED },
    });
  });

  it('uninstall: soft deletes the installation and every repo, and keeps the rows', async () => {
    await service.deleted(installationEvent('deleted', ids.installation));

    const installation = await installationRow(ids.installation);
    expect(installation.deletedAt).toBeInstanceOf(Date);

    for (const id of [ids.repoA, ids.repoB]) {
      expect((await repoRow(id)).deletedAt).toBeInstanceOf(Date);
    }
    expect((await repoRow(ids.repoA)).reviews).toHaveLength(1);

    expect(invalidate).toHaveBeenCalledWith(ids.installation);
  });

  it('reinstall under the same installation ID: revives the original rows', async () => {
    const before = await installationRow(ids.installation);

    await service.created(installationEvent('created', ids.installation, [repoA]));

    const after = await installationRow(ids.installation);
    expect(after.id).toBe(before.id); // same row, not a new one
    expect(after.deletedAt).toBeNull();

    const repo = await repoRow(ids.repoA);
    expect(repo.deletedAt).toBeNull();
    expect(repo.reviews).toHaveLength(1);

    // Only repos granted again come back. Beta was not in this reinstall.
    expect((await repoRow(ids.repoB)).deletedAt).toBeInstanceOf(Date);
  });

  // GitHub may issue a new installation ID on reinstall. History must still come back,
  // because it hangs off the Repo, and repo IDs survive an uninstall.
  it('reinstall under a new installation ID: the old repo row follows it, history intact', async () => {
    await service.deleted(installationEvent('deleted', ids.installation));
    await service.created(installationEvent('created', ids.reinstalled, [repoA]));

    const fresh = await installationRow(ids.reinstalled);
    const repo = await repoRow(ids.repoA);

    expect(repo.installationId).toBe(fresh.id);
    expect(repo.deletedAt).toBeNull();
    expect(repo.reviews).toHaveLength(1);

    // The old installation stays as a soft-deleted record of the first install.
    expect((await installationRow(ids.installation)).deletedAt).toBeInstanceOf(Date);
  });

  it('suspend and unsuspend set and clear suspendedAt, and evict the token on suspend', async () => {
    const suspendedAt = '2026-09-11T10:00:00Z';
    await service.suspended({
      ...installationEvent('suspend', ids.reinstalled),
      installation: { id: ids.reinstalled, account: { login: 'itest-owner', type: 'User' }, suspended_at: suspendedAt },
    });

    expect((await installationRow(ids.reinstalled)).suspendedAt).toEqual(new Date(suspendedAt));
    expect(invalidate).toHaveBeenCalledWith(ids.reinstalled);

    await service.unsuspended(installationEvent('unsuspend', ids.reinstalled));
    expect((await installationRow(ids.reinstalled)).suspendedAt).toBeNull();
  });

  it('repositories added and removed: upserts and soft deletes individual repos', async () => {
    const installation = { id: ids.reinstalled, account: { login: 'itest-owner', type: 'User' } };
    const beta = { id: ids.repoB, full_name: `itest-owner/beta-${base}`, private: true };

    await service.reposAdded({ action: 'added', installation, repositories_added: [beta], repositories_removed: [] });
    const added = await repoRow(ids.repoB);
    expect(added.deletedAt).toBeNull();
    expect(added.installationId).toBe((await installationRow(ids.reinstalled)).id);

    await service.reposRemoved({ action: 'removed', installation, repositories_added: [], repositories_removed: [beta] });
    expect((await repoRow(ids.repoB)).deletedAt).toBeInstanceOf(Date);
  });

  // Two deliveries creating the same new rows at once. No retry is needed here, unlike the
  // pull_request path: `Installation` has a single unique column, so its upsert is a
  // native INSERT … ON CONFLICT, and the second transaction waits on the first's row lock
  // until it commits — the repo upserts after it can no longer race. This pins that down.
  it('survives two concurrent installation.created deliveries for the same new installation', async () => {
    const racer = base + 50;
    const racerRepo = { id: base + 51, name: 'race' };

    await Promise.all([
      service.created(installationEvent('created', racer, [racerRepo])),
      service.created(installationEvent('created', racer, [racerRepo])),
    ]);

    expect(await prisma.installation.count({ where: { githubId: BigInt(racer) } })).toBe(1);
    expect(await prisma.repo.count({ where: { githubId: BigInt(racerRepo.id) } })).toBe(1);

    await prisma.repo.deleteMany({ where: { githubId: BigInt(racerRepo.id) } });
    await prisma.installation.deleteMany({ where: { githubId: BigInt(racer) } });
  });

  it('uninstalling an installation that was never recorded is a no-op, not an error', async () => {
    await expect(service.deleted(installationEvent('deleted', base + 99))).resolves.toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith(base + 99);
  });
});
