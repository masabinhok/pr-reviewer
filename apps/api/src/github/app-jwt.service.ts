import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

// GitHub rejects a JWT whose `iat` is in the future by its own clock. Backdating absorbs
// drift between this machine and GitHub's; 60s is GitHub's own recommendation.
const CLOCK_SKEW_SECONDS = 60;
// GitHub's hard ceiling on App JWT lifetime. Asking for more is rejected, not clamped.
const LIFETIME_SECONDS = 600;

/**
 * Mints the App JWT: the credential that proves "I am this GitHub App". On its own it can
 * only call `/app/...` endpoints — its one real job here is to be exchanged for an
 * installation token, which is what actually touches repositories.
 */
@Injectable()
export class AppJwtService {
  private readonly appId: string;
  private readonly privateKey: KeyObject;

  constructor(config: ConfigService) {
    this.appId = config.getOrThrow<string>('github.appId');

    // Stored base64-encoded so a multi-line PEM fits on one .env line. Parsing it here,
    // once, means a malformed key fails at boot rather than on the first review.
    const pem = Buffer.from(
      config.getOrThrow<string>('github.privateKeyBase64'),
      'base64',
    ).toString('utf8');
    this.privateKey = createPrivateKey(pem);
  }

  /**
   * A fresh JWT on every call — deliberately never cached. Signing is local and costs
   * microseconds, so a cache would save nothing and add a second expiry to get wrong.
   */
  mint(): string {
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.appId,
      iat: now - CLOCK_SKEW_SECONDS,
      exp: now + LIFETIME_SECONDS,
    };

    // A JWT is three base64url segments: header.payload.signature, where the signature
    // covers exactly the first two segments as they appear in the token.
    const signingInput = `${base64url(header)}.${base64url(payload)}`;
    const signature = sign(
      'sha256',
      Buffer.from(signingInput),
      this.privateKey,
    );

    return `${signingInput}.${signature.toString('base64url')}`;
  }
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
