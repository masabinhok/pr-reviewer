import { ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DashboardTokenGuard } from './dashboard-token.guard.js';

const guard = (token: string | null) => new DashboardTokenGuard({ get: () => token } as unknown as ConfigService);
const request = (authorization?: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }) }) }) as unknown as ExecutionContext;

describe('DashboardTokenGuard', () => {
  it('lets the right token in', () => {
    expect(guard('s3cret-token').canActivate(request('Bearer s3cret-token'))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['the wrong token', 'Bearer nope'],
    ['a token of another length', 'Bearer s3cret-token-and-more'],
    ['the token without the scheme', 's3cret-token'],
    ['another scheme', 'Basic s3cret-token'],
    ['a repeated header', ['Bearer s3cret-token', 'Bearer s3cret-token']],
  ])('refuses %s with a 401', (_what, header) => {
    expect(() => guard('s3cret-token').canActivate(request(header))).toThrow(UnauthorizedException);
  });

  // Off means off: never an open dashboard because a setting was forgotten.
  it('refuses everything with a 503 when no token is configured', () => {
    expect(() => guard(null).canActivate(request('Bearer anything'))).toThrow(ServiceUnavailableException);
    expect(() => guard('').canActivate(request('Bearer '))).toThrow(ServiceUnavailableException);
  });
});
