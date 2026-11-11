import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class GithubSignatureGuard implements CanActivate {
  private readonly logger = new Logger(GithubSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Correlation ID only — never log the secret or the signature itself.
    const deliveryId = request.headers['x-github-delivery'] ?? 'unknown';

    const signature = request.headers['x-hub-signature-256'];

    // A repeated header arrives as string[]; treat anything non-string as missing.
    if (typeof signature !== 'string') {
      this.logger.warn(
        `[${deliveryId}] rejected: missing or duplicated signature header`,
      );
      throw new UnauthorizedException('Missing signature header');
    }

    const payload = request.rawBody;

    if (!payload || payload.length === 0) {
      this.logger.warn(`[${deliveryId}] rejected: missing raw body`);
      throw new UnauthorizedException('Missing raw body');
    }

    const secret = this.config.getOrThrow<string>('github.webhookSecret');

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const received = Buffer.from(signature, 'utf8');
    const digest = Buffer.from(expected, 'utf8');

    // timingSafeEqual throws RangeError on mismatched lengths, which would surface
    // as a 500. Length-check first so malformed signatures are a plain 401.
    if (
      received.length !== digest.length ||
      !crypto.timingSafeEqual(received, digest)
    ) {
      this.logger.warn(`[${deliveryId}] rejected: invalid signature`);
      throw new UnauthorizedException('Invalid Signature');
    }

    return true;
  }
}
