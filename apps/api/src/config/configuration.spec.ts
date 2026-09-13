import configuration from './configuration.js';

describe('configuration: posting.minSeverity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('posts high findings only unless told otherwise', () => {
    vi.stubEnv('POST_MIN_SEVERITY', undefined);

    expect(configuration().posting.minSeverity).toBe('HIGH');
  });

  it('reads the bar in any case', () => {
    vi.stubEnv('POST_MIN_SEVERITY', 'Medium');

    expect(configuration().posting.minSeverity).toBe('MEDIUM');
  });

  // A typo must stop the app at boot, not quietly post everything or nothing.
  it('refuses a value that is not a severity', () => {
    vi.stubEnv('POST_MIN_SEVERITY', 'hihg');

    expect(() => configuration()).toThrow('POST_MIN_SEVERITY must be one of high, medium, low; got "hihg"');
  });
});
