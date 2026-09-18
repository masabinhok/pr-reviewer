import Link from 'next/link';
import { api } from '@/lib/api';
import { ago, count, duration, shortSha } from '@/lib/format';
import { Problem, attempt } from '@/components/problem';
import { StatusText } from '@/components/tags';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reviews' };

const STATUSES = [
  ['', 'Any status'],
  ['COMPLETED', 'Reviewed'],
  ['FAILED', 'Failed'],
  ['SKIPPED', 'Too large to review'],
  ['RUNNING', 'Reviewing'],
  ['PENDING', 'Waiting'],
];

type Search = { repo?: string; status?: string; cursor?: string };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { repo = '', status = '', cursor = '' } = await searchParams;
  const [page, installs] = await Promise.all([
    attempt(() => api.reviews({ repo, status, cursor, limit: 25 })),
    attempt(() => api.installations()),
  ]);
  if (!page.ok) return <Problem error={page.error} />;
  const repos = installs.ok ? installs.data.flatMap((i) => i.repos.map((r) => r.fullName)) : [];
  const filtered = Boolean(repo || status);
  const next = page.data.nextCursor ? `/reviews?${new URLSearchParams({ ...(repo && { repo }), ...(status && { status }), cursor: page.data.nextCursor })}` : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[28px] font-bold leading-tight tracking-tight">Reviews</h1>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Repository
          <select name="repo" defaultValue={repo} className="rounded border border-rule bg-panel px-2 py-1.5 text-[15px] text-ink">
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Status
          <select name="status" defaultValue={status} className="rounded border border-rule bg-panel px-2 py-1.5 text-[15px] text-ink">
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded bg-accent px-3 py-1.5 font-bold text-panel">
          Show reviews
        </button>
        {filtered ? (
          <Link href="/reviews" className="py-1.5">
            Clear filters
          </Link>
        ) : null}
      </form>

      {page.data.items.length === 0 ? (
        <p className="text-ink-2">
          {filtered ? 'No reviews match these filters.' : 'No reviews yet. Open a pull request on a repository the App is installed on, and its review will appear here.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <thead className="text-[13px] text-muted">
              <tr className="border-b border-rule">
                <th className="py-2 pr-4 font-bold">Pull request</th>
                <th className="py-2 pr-4 font-bold">Status</th>
                <th className="py-2 pr-4 font-bold">When</th>
                <th className="py-2 pr-4 text-right font-bold">Time</th>
                <th className="py-2 pr-4 text-right font-bold">Kept</th>
                <th className="py-2 pr-4 text-right font-bold">Posted</th>
                <th className="py-2 text-right font-bold">Refuted</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((r) => (
                <tr key={r.id} className="border-b border-rule-soft align-top">
                  <td className="py-2.5 pr-4">
                    <Link href={`/reviews/${r.id}`} className="font-bold">
                      {r.repo} #{r.prNumber}
                    </Link>
                    <span className="ml-2 font-mono text-[13px] text-muted">{shortSha(r.headSha)}</span>
                    {r.model ? <p className="text-[13px] text-muted">{r.model}</p> : null}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusText status={r.status} />
                  </td>
                  <td className="py-2.5 pr-4 text-ink-2">{ago(r.startedAt)}</td>
                  <td className="py-2.5 pr-4 text-right">{duration(r.seconds)}</td>
                  <td className="py-2.5 pr-4 text-right">{count(r.findings)}</td>
                  <td className="py-2.5 pr-4 text-right">{count(r.posted)}</td>
                  <td className="py-2.5 text-right">{count(r.droppedOnSecondLook)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-6">
        {cursor ? <Link href={`/reviews?${new URLSearchParams({ ...(repo && { repo }), ...(status && { status }) })}`}>Back to the newest</Link> : null}
        {next ? <Link href={next}>Older reviews</Link> : null}
      </div>
    </div>
  );
}
