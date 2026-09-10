import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import { AppJwtService } from './app-jwt.service.js';

// A throwaway key pair, generated once for the file. The real App key never goes near a
// test — and with our own pair we hold the public half, so we can check the signature.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_BASE64 = Buffer.from(
  privateKey.export({ type: 'pkcs1', format: 'pem' }), // GitHub issues PKCS#1 keys too
).toString('base64');

const APP_ID = '123456';
const NOW = new Date('2026-09-10T12:00:00Z');
const NOW_SECONDS = NOW.getTime() / 1000;

function configWith(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

/** Splits a JWT and decodes the two JSON segments. */
function decode(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

describe('AppJwtService', () => {
  let service: AppJwtService;

  beforeEach(() => {
    // Only Date is faked. Faking timers too would stall anything awaiting a setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    service = new AppJwtService(
      configWith({ 'github.appId': APP_ID, 'github.privateKeyBase64': PRIVATE_KEY_BASE64 }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a three-segment RS256 JWT', () => {
    const jwt = service.mint();

    expect(jwt.split('.')).toHaveLength(3);
    expect(decode(jwt).header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('issues for the App ID, backdates iat by 60s, and expires in 600s', () => {
    const { payload } = decode(service.mint());

    expect(payload).toEqual({
      iss: APP_ID,
      iat: NOW_SECONDS - 60,
      exp: NOW_SECONDS + 600,
    });
  });

  // The test that matters: GitHub will check this signature with the public key it
  // holds for the App. Verifying with ours proves the token would pass that check.
  it('is signed by the configured private key', () => {
    const { signingInput, signature } = decode(service.mint());

    expect(verify('sha256', Buffer.from(signingInput), publicKey, signature)).toBe(true);
  });

  // And the converse, so the test above cannot pass by accident.
  it('does not verify against a different key', () => {
    const { publicKey: otherPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { signingInput, signature } = decode(service.mint());

    expect(verify('sha256', Buffer.from(signingInput), otherPublicKey, signature)).toBe(false);
  });

  it('mints a fresh token on every call rather than reusing one', () => {
    const first = decode(service.mint()).payload;
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    const second = decode(service.mint()).payload;

    expect(second.iat).toBe(first.iat + 5);
  });

  // Parsing in the constructor means a bad key stops the app at boot, not on the first
  // pull request an hour later.
  it('fails at construction when the private key is malformed', () => {
    const broken = configWith({
      'github.appId': APP_ID,
      'github.privateKeyBase64': Buffer.from('not a pem').toString('base64'),
    });

    expect(() => new AppJwtService(broken)).toThrow();
  });
});
