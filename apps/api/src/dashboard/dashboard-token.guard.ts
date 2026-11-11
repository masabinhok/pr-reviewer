import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The dashboard API's lock: `Authorization: Bearer <DASHBOARD_TOKEN>`.
 *
 * A single shared token, because the dashboard is a single-user tool that runs next to the
 * API (docs/decisions.md says why GitHub login is out of scope). Without a token configured
 * the endpoints refuse to run — 503, never open. The comparison is constant-time over hashes,
 * so neither the token's characters nor its length leak through response times.
 */
@Injectable()
export class DashboardTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string | null>('dashboard.token');
    if (!expected)
      throw new ServiceUnavailableException(
        'The dashboard is off: set DASHBOARD_TOKEN to turn it on.',
      );

    const header = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>().headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : null;
    if (
      presented === null ||
      !timingSafeEqual(digest(presented), digest(expected))
    ) {
      throw new UnauthorizedException('A valid dashboard token is required.');
    }
    return true;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();
