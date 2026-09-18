import 'server-only';

/**
 * The dashboard's only way to data: the API's read-only /api/dashboard endpoints, called from
 * this server with DASHBOARD_TOKEN. `server-only` makes importing this from a client
 * component a build error, so the token cannot end up in a browser bundle by accident.
 */

export interface FeedbackRate {
  posted: number;
  withFeedback: number;
  upvoted: number;
  downvoted: number;
}

export interface Overview {
  reviews: { total: number; completed: number; failed: number; skipped: number; inProgress: number };
  findings: {
    total: number;
    bySeverity: { high: number; medium: number; low: number };
    posted: number;
    repeats: number;
    resolved: { byApp: number; byPerson: number };
    verdicts: { confirmed: number; unsure: number; unverified: number };
    droppedOnSecondLook: number;
  };
  feedback: FeedbackRate;
  agent: {
    reviews: number;
    averageSeconds: number | null;
    averageTurns: number | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  perDay: { day: string; reviews: number; findings: number; posted: number }[];
}

export interface Installation {
  id: string;
  githubId: string;
  account: string;
  accountType: string;
  suspendedAt: string | null;
  deletedAt: string | null;
  repos: { id: string; fullName: string; private: boolean; deletedAt: string | null; reviews: number; lastReviewAt: string | null }[];
}

export interface ReviewSummary {
  id: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  startedAt: string;
  completedAt: string | null;
  seconds: number | null;
  error: string | null;
  skipReason: string | null;
  model: string | null;
  outcome: string | null;
  turns: number | null;
  toolCalls: number | null;
  verifyCalls: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  findings: number;
  posted: number;
  droppedOnSecondLook: number;
}

export interface ReviewPage {
  items: ReviewSummary[];
  nextCursor: string | null;
}

export interface Finding {
  id: string;
  path: string;
  line: number;
  side: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  summary: string;
  whyItBreaks: string;
  suggestedFix: string | null;
  verdict: 'CONFIRMED' | 'UNSURE' | 'UNVERIFIED' | null;
  verdictReason: string | null;
  demotedFrom: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  status: 'OPEN' | 'RESOLVED';
  resolvedBy: 'APP' | 'PERSON' | null;
  resolvedAt: string | null;
  posted: boolean;
  commentUrl: string | null;
  repeatOf: string | null;
  feedback: { up: number; down: number };
}

export type ReviewDetail = Omit<ReviewSummary, 'findings'> & {
  baseSha: string;
  checkRunUrl: string | null;
  findings: Finding[];
  dropped: { path: string; line: number; severity: string; summary: string; reason: string }[];
};

/** Why the dashboard has nothing to show — said plainly, with what to do about it. */
export class ApiUnavailable extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

export class NotFound extends Error {}

function settings() {
  return {
    // Not derived from PORT: Next sets PORT to its own port, which would point the dashboard at itself.
    url: (process.env.DASHBOARD_API_URL ?? 'http://localhost:3333').replace(/\/$/, ''),
    token: process.env.DASHBOARD_TOKEN ?? '',
  };
}

async function get<T>(path: string): Promise<T> {
  const { url, token } = settings();
  if (!token) throw new ApiUnavailable('No dashboard token is set.', 'Add DASHBOARD_TOKEN to the .env at the root of the repository, then restart the dashboard.');

  let response: Response;
  try {
    response = await fetch(`${url}/api/dashboard${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    throw new ApiUnavailable(`The API at ${url} is not answering.`, 'Start it with npm run start:dev in apps/api.');
  }
  if (response.status === 404) throw new NotFound(path);
  if (response.status === 401) throw new ApiUnavailable('The API refused the dashboard token.', 'Make sure the API and the dashboard read the same DASHBOARD_TOKEN, then restart both.');
  if (response.status === 503) throw new ApiUnavailable('The API has the dashboard turned off.', 'Set DASHBOARD_TOKEN in the root .env and restart the API.');
  if (!response.ok) throw new ApiUnavailable(`The API answered ${response.status}.`, 'Check the API’s log for the error.');
  return (await response.json()) as T;
}

export const api = {
  overview: () => get<Overview>('/overview'),
  installations: () => get<Installation[]>('/installations'),
  reviews: (query: { repo?: string; status?: string; cursor?: string; limit?: number }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    const qs = params.toString();
    return get<ReviewPage>(`/reviews${qs ? `?${qs}` : ''}`);
  },
  review: (id: string) => get<ReviewDetail>(`/reviews/${encodeURIComponent(id)}`),
};
