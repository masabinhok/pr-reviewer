const SEVERITIES = ['high', 'medium', 'low'] as const;

/** POST_MIN_SEVERITY, checked at boot: a typo must not silently post everything, or nothing. */
function postMinSeverity(): 'HIGH' | 'MEDIUM' | 'LOW' {
  const value = (process.env.POST_MIN_SEVERITY ?? 'high').toLowerCase();
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`POST_MIN_SEVERITY must be one of ${SEVERITIES.join(', ')}; got "${process.env.POST_MIN_SEVERITY}"`);
  }
  return value.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW';
}

export default () => ({
  port: parseInt(process.env.PORT ?? '', 10) || 3333,
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  queue: {
    // Namespaces every BullMQ key in Redis. The e2e suite sets its own, so test jobs
    // never land in the queue your dev server's worker is consuming.
    prefix: process.env.QUEUE_PREFIX ?? 'pr-reviewer',
    // First retry after this long, doubling after. The e2e suite shortens it so a test of
    // "fails every attempt" doesn't wait half a minute.
    retryDelayMs: Number(process.env.REVIEW_RETRY_DELAY_MS ?? 10_000),
  },
  posting: {
    // The least severe finding that becomes a comment on the pull request; everything below
    // it stays in the Check Run. High by default, from dogfooding: the local model's medium
    // findings on real pull requests were noise (see docs/decisions.md). With a stronger
    // model, medium is worth posting.
    minSeverity: postMinSeverity(),
  },
  agent: {
    // Which Reviewer runs: the agent when it is configured, the stub otherwise. REVIEWER
    // overrides either way (the e2e suite pins it to the stub).
    reviewer: process.env.REVIEWER ?? (process.env.AGENT_URL ? 'agent' : 'stub'),
    url: process.env.AGENT_URL,
    sharedSecret: process.env.AGENT_SHARED_SECRET,
    // A review is many model turns — minutes. Past this the job gives up and retries.
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 15 * 60_000),
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    privateKeyBase64: process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
  },
});
