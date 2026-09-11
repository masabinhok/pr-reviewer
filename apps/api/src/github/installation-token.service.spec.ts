import { Logger } from '@nestjs/common';
import { InstallationTokenService, installationTokenCacheKey } from './installation-token.service.js';
import { AppJwtService } from './app-jwt.service.js';
import { RedisService } from '../redis/redis.service.js';
import { redactToken } from './redact.js';

const INSTALLATION_ID = 42;
const APP_JWT = 'header.payload.signature';
const NOW = new Date('2026-09-10T12:00:00Z');
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * An in-memory Redis that honours TTLs against the (faked) clock. This is a *fake*, not
 * a stub: it has real behaviour, just a simpler implementation — which is what lets the
 * near-expiry test advance time and watch the key disappear the way Redis would.
 */
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.value;
  }

  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  /** Seconds left, like `redis-cli TTL`: -2 when the key does not exist. */
  ttl(key: string): number {
    const entry = this.store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) return -2;
    return Math.round((entry.expiresAt - Date.now()) / 1000);
  }
}

/** What GitHub's POST /app/installations/{id}/access_tokens returns. */
function githubTokenResponse(token: string, expiresInMs = ONE_HOUR_MS) {
  return new Response(
    JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('InstallationTokenService', () => {
  let service: InstallationTokenService;
  let redis: FakeRedis;
  let fetchMock: ReturnType<typeof vi.fn>;
  let logged: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    redis = new FakeRedis();
    const appJwt = { mint: () => APP_JWT } as unknown as AppJwtService;
    service = new InstallationTokenService(appJwt, redis as unknown as RedisService);

    // `fetch` is the network. Replacing the global is how "no network call" becomes
    // something a test can count.
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(githubTokenResponse('ghs_first')));
    vi.stubGlobal('fetch', fetchMock);

    // Capture every log line instead of printing it, so the redaction test can read them.
    logged = [];
    const capture = (message: unknown) => void logged.push(String(message));
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('cache miss', () => {
    it('exchanges the App JWT for an installation token', async () => {
      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_first');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${APP_JWT}`);
    });

    // GitHub's tokens live 3600s. Caching for 3540 is the whole point of the skew.
    it('caches the token for its lifetime minus 60 seconds', async () => {
      await service.getToken(INSTALLATION_ID);

      expect(redis.ttl(installationTokenCacheKey(INSTALLATION_ID))).toBe(3540);
    });

    it('does not cache a token that expires inside the skew window', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(githubTokenResponse('ghs_dying', 30_000)));

      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_dying');
      expect(redis.ttl(installationTokenCacheKey(INSTALLATION_ID))).toBe(-2);
    });
  });

  describe('cache hit', () => {
    it('serves the cached token without calling GitHub', async () => {
      await service.getToken(INSTALLATION_ID);
      fetchMock.mockClear();

      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_first');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keys the cache per installation', async () => {
      await service.getToken(INSTALLATION_ID);
      fetchMock.mockImplementation(() => Promise.resolve(githubTokenResponse('ghs_other')));

      const other = await service.getToken(99);

      expect(other).toBe('ghs_other');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // The two sides of the 60s boundary. Just inside it the cached token is still served;
  // just past it the cache has already let go, so the caller gets a freshly minted one
  // instead of a token with seconds left to live.
  describe('near expiry', () => {
    it('still serves from cache one second before the skewed TTL runs out', async () => {
      await service.getToken(INSTALLATION_ID);

      vi.setSystemTime(new Date(NOW.getTime() + 3539 * 1000));
      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_first');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('mints a fresh token once inside the last 60 seconds of the old one', async () => {
      await service.getToken(INSTALLATION_ID);
      fetchMock.mockImplementation(() => Promise.resolve(githubTokenResponse('ghs_second')));

      // 3541s in: GitHub would still accept ghs_first for another 59s, but we don't risk it.
      vi.setSystemTime(new Date(NOW.getTime() + 3541 * 1000));
      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_second');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // Suspend and uninstall revoke the token on GitHub's side immediately; the cache must
  // not keep handing it out for the rest of its hour.
  describe('invalidate', () => {
    it('drops the cached token so the next call mints a fresh one', async () => {
      await service.getToken(INSTALLATION_ID);
      fetchMock.mockImplementation(() => Promise.resolve(githubTokenResponse('ghs_second')));

      await service.invalidate(INSTALLATION_ID);
      const token = await service.getToken(INSTALLATION_ID);

      expect(token).toBe('ghs_second');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('secrets', () => {
    it('never logs the token value', async () => {
      await service.getToken(INSTALLATION_ID); // miss: logs the mint
      await service.getToken(INSTALLATION_ID); // hit: logs the cache read

      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join('\n')).not.toContain('ghs_first');
      expect(logged.join('\n')).toContain('ghs_***');
    });

    it('reports a GitHub refusal without leaking the App JWT', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
        ),
      );

      const attempt = service.getToken(INSTALLATION_ID);

      await expect(attempt).rejects.toThrow('401 Bad credentials');
      await expect(attempt).rejects.not.toThrow(APP_JWT);
    });
  });
});

describe('redactToken', () => {
  it.each([
    ['ghs_16C7e42F292c6912E7710c838347Ae178B4a', 'ghs_***'],
    ['ghp_abcdef', 'ghp_***'],
    ['github_pat_11ABCDEF', 'github_pat_***'],
    ['something-unexpected', '***'],
  ])('%s → %s', (input, expected) => {
    expect(redactToken(input)).toBe(expected);
  });
});
