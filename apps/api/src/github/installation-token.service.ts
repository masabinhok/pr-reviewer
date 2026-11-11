import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { AppJwtService } from './app-jwt.service.js';
import { redactToken } from './redact.js';

const GITHUB_API = 'https://api.github.com';

// Expire the cache entry this long before GitHub expires the token. A token served
// with seconds to live can die mid-request, and that surfaces as a 401 that only
// happens once an hour — the kind of flake you lose a day to.
const CACHE_SKEW_SECONDS = 60;

export type InstallationId = bigint | number | string;

export function installationTokenCacheKey(
  installationId: InstallationId,
): string {
  return `gh:itoken:${installationId}`;
}

/**
 * Installation tokens act on one installation's repositories with that installation's
 * permissions, and last one hour. Minting one is a network round trip to GitHub, so
 * they are cached in Redis — shared across instances and surviving restarts, which an
 * in-process cache would not.
 */
@Injectable()
export class InstallationTokenService {
  private readonly logger = new Logger(InstallationTokenService.name);

  constructor(
    private readonly appJwt: AppJwtService,
    private readonly redis: RedisService,
  ) {}

  async getToken(installationId: InstallationId): Promise<string> {
    const key = installationTokenCacheKey(installationId);

    const cached = await this.redis.get(key);
    if (cached) {
      this.logger.debug(
        `installation ${installationId}: served ${redactToken(cached)} from cache`,
      );
      return cached;
    }

    const { token, expiresAt } = await this.exchange(installationId);

    // Redis evicts the key before GitHub expires the token, so "near expiry" needs no
    // check of its own: past the skew window the next call is simply a miss.
    const ttl =
      Math.floor((expiresAt.getTime() - Date.now()) / 1000) -
      CACHE_SKEW_SECONDS;
    if (ttl > 0) {
      await this.redis.set(key, token, 'EX', ttl);
    }

    this.logger.log(
      `installation ${installationId}: minted ${redactToken(token)}, cached for ${Math.max(ttl, 0)}s`,
    );
    return token;
  }

  /**
   * Drops the cached token for an installation. Called when an installation is suspended
   * or uninstalled: GitHub revokes the token immediately, but the cache would otherwise
   * keep serving it for up to an hour, and every call made with it would 401.
   */
  async invalidate(installationId: InstallationId): Promise<void> {
    await this.redis.del(installationTokenCacheKey(installationId));
  }

  private async exchange(
    installationId: InstallationId,
  ): Promise<{ token: string; expiresAt: Date }> {
    const response = await fetch(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.appJwt.mint()}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pr-reviewer',
        },
      },
    );

    if (!response.ok) {
      // Only GitHub's `message` goes into the error — never the request, which carries
      // the JWT in its Authorization header.
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(
        `GitHub refused an installation token for installation ${installationId}: ` +
          `${response.status} ${body.message ?? response.statusText}`,
      );
    }

    const body = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }
}
