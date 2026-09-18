import Link from 'next/link';
import { api, type Installation } from '@/lib/api';
import { ago, count } from '@/lib/format';
import { Problem, attempt } from '@/components/problem';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Installations' };

/** Where the App works now comes first; uninstalled and suspended history after it. */
const rank = (i: Installation) => (i.deletedAt ? 2 : i.suspendedAt ? 1 : 0);

export default async function InstallationsPage() {
  const result = await attempt(() => api.installations());
  if (!result.ok) return <Problem error={result.error} />;
  const installs = [...result.data].sort((a, b) => rank(a) - rank(b));
  const current = installs.filter((i) => !i.deletedAt);
  const past = installs.filter((i) => i.deletedAt);

  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-[28px] font-bold leading-tight tracking-tight">Installations</h1>
      {current.length === 0 ? (
        <p className="text-ink-2">The App isn’t installed anywhere right now. Install it on a repository from its GitHub settings page, and it will show up here.</p>
      ) : (
        current.map((i) => <InstallationSection key={i.id} i={i} />)
      )}
      {past.length ? (
        <details>
          <summary className="cursor-pointer text-ink-2">
            {past.length} earlier installation{past.length === 1 ? '' : 's'}, since uninstalled
          </summary>
          <div className="mt-6 flex flex-col gap-10">
            {past.map((i) => (
              <InstallationSection key={i.id} i={i} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function InstallationSection({ i }: { i: Installation }) {
  const active = i.repos.filter((r) => !r.deletedAt);
  const removed = i.repos.filter((r) => r.deletedAt);
  return (
    <section>
      <h2 className="text-[19px] font-bold">
        {i.account} <span className="font-normal text-muted">({i.accountType === 'Organization' ? 'organisation' : 'user'})</span>
      </h2>
      {i.deletedAt ? (
        <p className="text-muted">Uninstalled {ago(i.deletedAt)}.</p>
      ) : i.suspendedAt ? (
        <p className="text-[var(--medium)]">Suspended {ago(i.suspendedAt)}: no reviews run until it is unsuspended.</p>
      ) : null}
      {active.length ? <RepoTable repos={active} /> : <p className="mt-2 text-ink-2">No repositories.</p>}
      {removed.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] text-muted">
            {removed.length} repositor{removed.length === 1 ? 'y' : 'ies'} removed from the App
          </summary>
          <RepoTable repos={removed} />
        </details>
      ) : null}
    </section>
  );
}

function RepoTable({ repos }: { repos: Installation['repos'] }) {
  return (
    <table className="mt-3 w-full max-w-2xl text-left">
      <thead className="text-[13px] text-muted">
        <tr className="border-b border-rule">
          <th className="py-2 pr-4 font-bold">Repository</th>
          <th className="py-2 pr-4 text-right font-bold">Reviews</th>
          <th className="whitespace-nowrap py-2 font-bold">Last review</th>
        </tr>
      </thead>
      <tbody>
        {repos.map((r) => (
          <tr key={r.id} className="border-b border-rule-soft">
            <td className="py-2 pr-4">
              <Link href={`/reviews?repo=${encodeURIComponent(r.fullName)}`}>{r.fullName}</Link>
              {r.private ? <span className="ml-2 text-[13px] text-muted">private</span> : null}
            </td>
            <td className="py-2 pr-4 text-right">{count(r.reviews)}</td>
            <td className="whitespace-nowrap py-2 text-ink-2">{r.lastReviewAt ? ago(r.lastReviewAt) : 'Never'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
