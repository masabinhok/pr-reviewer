import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { GithubSignatureGuard } from './signature.guard.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

/** Computes the signature GitHub would send for this body. */
function sign(body: string, secret = WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

/**
 * Builds the smallest object the guard can work with. The guard only ever touches
 * `switchToHttp().getRequest()`, so that is all we fake — the cast says
 * "this is enough for the code under test", not "this is a real ExecutionContext".
 */
function contextFor(options: { body?: string; signature?: unknown }): ExecutionContext {
  const headers: Record<string, unknown> = { 'x-github-delivery': 'test-delivery-id' };

  if (options.signature !== undefined) {
    headers['x-hub-signature-256'] = options.signature;
  }

  const request = {
    headers,
    rawBody: options.body === undefined ? undefined : Buffer.from(options.body),
  };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('GithubSignatureGuard', () => {
  let guard: GithubSignatureGuard;

  beforeEach(() => {
    // Fresh guard per test so no state leaks between them.
    const config = { getOrThrow: () => WEBHOOK_SECRET } as unknown as ConfigService;
    guard = new GithubSignatureGuard(config);

    // The guard warns on every rejection; keep the expected noise out of the output.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a request whose signature matches the body', () => {
    const body = '{"action":"opened"}';
    const context = contextFor({ body, signature: sign(body) });

    expect(guard.canActivate(context)).toBe(true);
  });

  // The assertion is on the *type* of error, because that type is what Nest turns
  // into a 401. Asserting `.toThrow()` alone would also pass on a RangeError,
  // which would really be a 500 — see the wrong-length case below.
  it('rejects a request with no signature header', () => {
    const context = contextFor({ body: '{"action":"opened"}' }); // signature omitted

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a signature computed with the wrong secret', ()=> {
    const body = '{"action": "opened"}';
    const signature = sign(body, 'wrongsecret')

    const context = contextFor({
      body: body, 
      signature: signature
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)

  })

  // Catches someone verifying against JSON.stringify(req.body) instead of rawBody.
  it('rejects a body that was tampered with after signing', ()=> {
    const body = '{"action": "opened"}';
    const signature = sign(body, WEBHOOK_SECRET)

    const newBody = '{"fakeBody": "false"}';
    const context = contextFor({
      body: newBody, 
      signature: signature
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)
  })

  // Dropping the prefix changes the length, so timingSafeEqual would throw RangeError
  // unless the guard length-checks first. UnauthorizedException here is the
  // difference between a 401 and a 500.
  it('rejects a malformed header with no sha256= prefix', ()=> {
    const body = '{"action": "opened"}';
    const signature = sign(body)
    const strippedSign = signature.slice('sha256='.length)
    
    const context = contextFor({
      body: body, 
      signature: strippedSign
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)

  });

  // Same trap as above.
  it('rejects a wrong-length signature with 401 rather than crashing', ()=> {
    const body = '{"action": "opened"}';
    const signature = 'sha256=abc'
    
    const context = contextFor({
      body: body, 
      signature: signature
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)
  })

  it('rejects an empty raw body', ()=> {
    const body = ""
    const signature = sign('')

    const context = contextFor({
      body,
      signature
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)
  });


  it('rejects a missing raw body', ()=> {
    const signature = sign('')

    const context = contextFor({
      signature
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)
  });

  // A valid body, so the repeated header is the only thing wrong.
  it('rejects a request with array as the header', ()=> {
    const body = '{"action": "opened"}';

    const context = contextFor({
      body,
      signature: ['sha256=a', 'sha256=b']
    })

    expect(()=> guard.canActivate(context)).toThrow(UnauthorizedException)
  });

});
