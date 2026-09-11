/**
 * A GitHub API call that failed. The message carries GitHub's own `message` and the
 * path — never the request, whose Authorization header holds the token.
 */
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    githubMessage: string,
  ) {
    super(`GitHub ${status} on ${path}: ${githubMessage}`);
    this.name = 'GithubApiError';
  }
}

/**
 * GitHub said "slow down". Not a failure of the work: the caller should wait until
 * `retryAt` and try again, not spend one of its limited retry attempts.
 *
 * - `primary`: the hourly budget is spent (`x-ratelimit-remaining: 0`); resets at `x-ratelimit-reset`.
 * - `secondary`: too much, too fast; GitHub says how long via `retry-after`, or else wait a minute.
 */
export class GithubRateLimitError extends Error {
  constructor(
    readonly kind: 'primary' | 'secondary',
    readonly retryAt: Date,
    readonly path: string,
  ) {
    super(`GitHub ${kind} rate limit on ${path}; retry at ${retryAt.toISOString()}`);
    this.name = 'GithubRateLimitError';
  }
}
