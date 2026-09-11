import { Injectable, Logger } from '@nestjs/common';
import { InstallationTokenService, type InstallationId } from './installation-token.service.js';
import { GithubApiError, GithubRateLimitError } from './github-api.errors.js';

const GITHUB_API = 'https://api.github.com';
const JSON_MEDIA = 'application/vnd.github+json';
const DIFF_MEDIA = 'application/vnd.github.diff';

// GitHub's own guidance when a secondary limit arrives without a retry-after header.
const SECONDARY_LIMIT_FALLBACK_MS = 60_000;

// The pull-request files endpoint stops at 3000 files; asking for more pages returns nothing.
export const MAX_PULL_REQUEST_FILES = 3000;

/** One entry from `GET /repos/{owner}/{repo}/pulls/{n}/files`. */
export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary files and for files too large for GitHub to render a patch. */
  patch?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
}

interface RequestOptions {
  accept?: string;
  method?: string;
  body?: unknown;
}

/**
 * The one place that calls the GitHub REST API as an installation. Every later milestone
 * asks this service for "the files of PR 12" instead of building fetch calls itself, so
 * tokens, pagination, rate limits and error redaction are handled once.
 */
@Injectable()
export class GithubApiService {
  private readonly logger = new Logger(GithubApiService.name);

  constructor(private readonly tokens: InstallationTokenService) {}

  getPullRequest(installationId: InstallationId, repo: string, number: number): Promise<PullRequest> {
    return this.json<PullRequest>(installationId, `/repos/${repo}/pulls/${number}`);
  }

  /** Every changed file, across pages, up to GitHub's 3000-file cap. */
  listPullRequestFiles(installationId: InstallationId, repo: string, number: number): Promise<PullRequestFile[]> {
    return this.paginate<PullRequestFile>(installationId, `/repos/${repo}/pulls/${number}/files?per_page=100`, {
      max: MAX_PULL_REQUEST_FILES,
    });
  }

  /**
   * The unified diff between two exact commits. Compare, not `/pulls/{n}`, because the
   * PR endpoint returns the diff as of *now* — after a new push it would no longer match
   * the head SHA this review was created for. Three dots: diffed from the merge base,
   * which is what the PR's "Files changed" tab shows.
   */
  async getDiff(installationId: InstallationId, repo: string, base: string, head: string): Promise<string> {
    const response = await this.request(installationId, `/repos/${repo}/compare/${base}...${head}`, {
      accept: DIFF_MEDIA,
    });
    return response.text();
  }

  async json<T>(installationId: InstallationId, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(installationId, path, options);
    return (await response.json()) as T;
  }

  /** Follows `Link: <…>; rel="next"` until there is no next page or `max` items are in hand. */
  async paginate<T>(installationId: InstallationId, path: string, { max = Infinity } = {}): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;

    while (next && items.length < max) {
      const response = await this.request(installationId, next);
      items.push(...((await response.json()) as T[]));
      next = nextPage(response.headers.get('link'));
    }

    return items.slice(0, max);
  }

  /**
   * A single authenticated request. On a 401 the cached token is dropped and the request
   * retried once with a fresh one — a token revoked early (installation suspended and
   * restored, permissions changed) would otherwise keep failing until its cache TTL ran
   * out.
   */
  async request(installationId: InstallationId, pathOrUrl: string, options: RequestOptions = {}): Promise<Response> {
    const path = pathOrUrl.startsWith(GITHUB_API) ? pathOrUrl.slice(GITHUB_API.length) : pathOrUrl;

    let response = await this.send(installationId, path, options);
    if (response.status === 401) {
      this.logger.warn(`installation ${installationId}: 401 on ${stripQuery(path)}, refreshing the token once`);
      await this.tokens.invalidate(installationId);
      response = await this.send(installationId, path, options);
    }

    if (response.ok) return response;
    throw await failure(response, stripQuery(path));
  }

  private async send(installationId: InstallationId, path: string, options: RequestOptions): Promise<Response> {
    const token = await this.tokens.getToken(installationId);
    return fetch(`${GITHUB_API}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: options.accept ?? JSON_MEDIA,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pr-reviewer',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }
}

/** Turns a non-2xx response into the right error: rate limited, or failed. */
async function failure(response: Response, path: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  const message = body.message ?? response.statusText;

  if (response.status === 403 || response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      return new GithubRateLimitError('secondary', new Date(Date.now() + Number(retryAfter) * 1000), path);
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      return new GithubRateLimitError('primary', new Date(reset), path);
    }
    if (/secondary rate limit/i.test(message)) {
      return new GithubRateLimitError('secondary', new Date(Date.now() + SECONDARY_LIMIT_FALLBACK_MS), path);
    }
  }

  return new GithubApiError(response.status, path, message);
}

function nextPage(link: string | null): string | null {
  return /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
}

function stripQuery(path: string): string {
  return path.split('?')[0];
}
