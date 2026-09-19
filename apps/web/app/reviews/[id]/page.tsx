import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFound, api, type Finding } from '@/lib/api';
import { ago, count, duration, money, shortSha, tokens } from '@/lib/format';
import { Problem, attempt } from '@/components/problem';
import { SeverityTag, StatusText, VerdictTag } from '@/components/tags';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Review ${id.slice(-6)}` };
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let result;
  try {
    result = await attempt(() => api.review(id));
  } catch (e) {
    if (e instanceof NotFound) notFound();
    throw e;
  }
  if (!result.ok) return <Problem error={result.error} />;
  const r = result.data;
  const posted = r.findings.filter((f) => f.posted);
  const notPosted = r.findings.filter((f) => !f.posted);

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="text-[13px] text-muted">
          <Link href="/reviews">Reviews</Link>
        </p>
        <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-tight">
          <a href={r.prUrl}>
            {r.repo} #{r.prNumber}
          </a>
        </h1>
        <p className="mt-1 text-ink-2">
          <StatusText status={r.status} /> {ago(r.startedAt)}, at <span className="font-mono text-[14px]">{shortSha(r.headSha)}</span>
          {r.checkRunUrl ? (
            <>
              {' '}
              — <a href={r.checkRunUrl}>open the Check Run</a>
            </>
          ) : null}
        </p>
        {r.error ? <p className="mt-3 max-w-2xl rounded border border-rule bg-panel p-3 text-[14px] text-[var(--high)]">{r.error}</p> : null}
        {r.skipReason ? <p className="mt-3 text-ink-2">Not reviewed: {r.skipReason}.</p> : null}
      </header>

      {r.model ? (
        <dl className="grid max-w-3xl grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <Fact label="Model" value={r.model} />
          <Fact label="Time" value={duration(r.seconds)} />
          <Fact label="Turns, tool calls" value={`${r.turns ?? '—'}, ${r.toolCalls ?? '—'}`} />
          <Fact label="Second-look checks" value={r.verifyCalls === null ? '—' : count(r.verifyCalls)} />
          <Fact label="Tokens in" value={tokens(r.tokensIn)} />
          <Fact label="Tokens out" value={tokens(r.tokensOut)} />
          <Fact label="Cost" value={money(r.costUsd)} />
        </dl>
      ) : null}

      <FindingList title={`Posted on the pull request (${posted.length})`} empty="Nothing was posted." findings={posted} />
      <FindingList
        title={`Kept but not posted (${notPosted.length})`}
        empty="Every kept finding was posted."
        intro="Below the posting bar, not confirmed by the second look, or already commented on by an earlier review."
        findings={notPosted}
      />

      {r.dropped.length ? (
        <section>
          <h2 className="text-[19px] font-bold">Refuted by the second look ({r.dropped.length})</h2>
          <p className="mt-1 text-[13px] text-muted">The reviewer proposed these; checking each against the code showed it was wrong, so it was dropped.</p>
          <ul className="mt-3 flex flex-col gap-3">
            {r.dropped.map((d, i) => (
              <li key={i} className="border-l-2 border-rule pl-3">
                <p>
                  <span className="font-mono text-[13px] text-muted">
                    {d.path}:{d.line}
                  </span>{' '}
                  <span className="text-ink-2 line-through decoration-rule">{d.summary}</span>
                </p>
                <p className="text-[14px] text-ink-2">Why: {d.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}

function FindingList({ title, intro, empty, findings }: { title: string; intro?: string; empty: string; findings: Finding[] }) {
  return (
    <section>
      <h2 className="text-[19px] font-bold">{title}</h2>
      {intro ? <p className="mt-1 text-[13px] text-muted">{intro}</p> : null}
      {findings.length === 0 ? (
        <p className="mt-3 text-ink-2">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-rule-soft border-y border-rule">
          {findings.map((f) => (
            <li key={f.id} className="py-4">
              <FindingItem f={f} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FindingItem({ f }: { f: Finding }) {
  return (
    <article className="max-w-3xl">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SeverityTag severity={f.severity} demotedFrom={f.demotedFrom} />
        <span className="font-mono text-[13px] text-ink-2">
          {f.path}:{f.line}
        </span>
        <span className="text-[13px] text-muted">{f.category}</span>
      </p>
      <p className="mt-2 font-bold">{f.summary}</p>
      <p className="mt-1 text-ink-2">{f.whyItBreaks}</p>
      {f.suggestedFix ? <p className="mt-1 text-ink-2">Suggested fix: {f.suggestedFix}</p> : null}
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <VerdictTag verdict={f.verdict} />
        {f.verdictReason ? <span className="text-muted">{f.verdictReason}</span> : null}
      </p>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
        {f.commentUrl ? <a href={f.commentUrl}>See the comment</a> : null}
        {f.repeatOf ? <span>Already commented on by an earlier review</span> : null}
        {f.status === 'RESOLVED' ? <span>Resolved {f.resolvedBy === 'PERSON' ? 'by a person' : 'by the reviewer: the code changed'}</span> : null}
        {f.feedback.up || f.feedback.down ? (
          <span>
            {f.feedback.up ? `👍 ${f.feedback.up}` : ''} {f.feedback.down ? `👎 ${f.feedback.down}` : ''}
          </span>
        ) : null}
      </p>
    </article>
  );
}
