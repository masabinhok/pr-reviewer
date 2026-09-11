import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { InstallationTokenService } from '../github/installation-token.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  GithubInstallation,
  GithubInstallationRepo,
  InstallationPayload,
  InstallationRepositoriesPayload,
} from './github-payloads.js';

type Tx = Prisma.TransactionClient;

/**
 * Keeps `Installation` and `Repo` in step with where the App is installed. Nothing here
 * ever deletes a row: uninstalling and losing access are recorded with `deletedAt`, so a
 * repo's review history survives an uninstall and comes back on reinstall.
 */
@Injectable()
export class InstallationsService {
  private readonly logger = new Logger(InstallationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: InstallationTokenService,
  ) {}

  /** `installation.created` — also how a reinstall revives previously soft-deleted rows. */
  async created(payload: InstallationPayload): Promise<void> {
    const repos = payload.repositories ?? [];

    await this.prisma.$transaction(async (tx) => {
      const installation = await upsertInstallation(tx, payload.installation);
      await upsertRepos(tx, installation.id, repos);
    });

    this.logger.log(
      `installation ${payload.installation.id} (${payload.installation.account.login}) created with ${repos.length} repo(s)`,
    );
  }

  /** `installation.deleted` — soft delete the installation and every repo under it. */
  async deleted(payload: InstallationPayload): Promise<void> {
    const now = new Date();

    const found = await this.prisma.$transaction(async (tx) => {
      const installation = await tx.installation.findUnique({
        where: { githubId: BigInt(payload.installation.id) },
      });
      if (!installation) return false;

      await tx.installation.update({ where: { id: installation.id }, data: { deletedAt: now } });
      await tx.repo.updateMany({
        where: { installationId: installation.id, deletedAt: null },
        data: { deletedAt: now },
      });
      return true;
    });

    // Evict even when there was no row: the token cache is keyed on GitHub's ID, not ours.
    await this.tokens.invalidate(payload.installation.id);

    this.logger.log(
      found
        ? `installation ${payload.installation.id} deleted (soft)`
        : `installation ${payload.installation.id} deleted, but was never recorded — nothing to soft delete`,
    );
  }

  /** `installation.suspend` — GitHub revokes the installation's tokens, so drop ours too. */
  async suspended(payload: InstallationPayload): Promise<void> {
    const suspendedAt = payload.installation.suspended_at
      ? new Date(payload.installation.suspended_at)
      : new Date();

    await this.prisma.installation.updateMany({
      where: { githubId: BigInt(payload.installation.id) },
      data: { suspendedAt },
    });
    await this.tokens.invalidate(payload.installation.id);

    this.logger.log(`installation ${payload.installation.id} suspended`);
  }

  /** `installation.unsuspend` */
  async unsuspended(payload: InstallationPayload): Promise<void> {
    await this.prisma.installation.updateMany({
      where: { githubId: BigInt(payload.installation.id) },
      data: { suspendedAt: null },
    });

    this.logger.log(`installation ${payload.installation.id} unsuspended`);
  }

  /** `installation_repositories.added` — the user granted the App more repositories. */
  async reposAdded(payload: InstallationRepositoriesPayload): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Upsert rather than look up: the payload carries the full installation, so an
      // installation recorded before these handlers existed heals itself here.
      const installation = await upsertInstallation(tx, payload.installation);
      await upsertRepos(tx, installation.id, payload.repositories_added);
    });

    this.logger.log(
      `installation ${payload.installation.id}: ${payload.repositories_added.length} repo(s) added`,
    );
  }

  /** `installation_repositories.removed` — access withdrawn; keep the rows, hide them. */
  async reposRemoved(payload: InstallationRepositoriesPayload): Promise<void> {
    const { count } = await this.prisma.repo.updateMany({
      where: {
        githubId: { in: payload.repositories_removed.map((r) => BigInt(r.id)) },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    this.logger.log(`installation ${payload.installation.id}: ${count} repo(s) removed (soft)`);
  }
}

function upsertInstallation(tx: Tx, installation: GithubInstallation) {
  const fields = {
    accountLogin: installation.account.login,
    accountType: installation.account.type,
  };

  return tx.installation.upsert({
    where: { githubId: BigInt(installation.id) },
    create: { githubId: BigInt(installation.id), ...fields },
    // Reinstalling revives the row: an upsert that left deletedAt set would bring the
    // installation back and keep hiding it from every "active installations" query.
    update: { ...fields, deletedAt: null, suspendedAt: null },
  });
}

async function upsertRepos(tx: Tx, installationId: string, repos: GithubInstallationRepo[]) {
  for (const repo of repos) {
    const fields = { fullName: repo.full_name, private: repo.private, installationId };

    await tx.repo.upsert({
      // Keyed on the repo's GitHub ID, which survives an uninstall. If a reinstall comes
      // back under a *new* installation ID, this re-points the old Repo row at the new
      // Installation — so its Reviews follow it instead of being orphaned.
      where: { githubId: BigInt(repo.id) },
      create: { githubId: BigInt(repo.id), ...fields },
      update: { ...fields, deletedAt: null },
    });
  }
}
