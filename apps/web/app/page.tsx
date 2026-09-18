import { api } from '@/lib/api';
import { count, duration, money, percent, tokens } from '@/lib/format';
import { funnel } from '@/lib/funnel';
import { DayBars } from '@/components/day-bars';
import { Funnel } from '@/components/funnel';
import { Problem, attempt } from '@/components/problem';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const result = await attempt(() => api.overview());
  if (!result.ok) return <Problem error={result.error} />;
  const o = result.data;

  const refuted = o.findings.droppedOnSecondLook;
  const checked = o.findings.verdicts.confirmed + o.findings.verdicts.unsure + o.findings.verdicts.unverified + refuted;

  return (
    <div className="flex flex-col gap-12">
      <header>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">How the reviewer is doing</h1>
        <p className="mt-1 text-ink-2">
          {count(o.reviews.total)} reviews: {count(o.reviews.completed)} finished, {count(o.reviews.failed)} failed, {count(o.reviews.skipped)} too large
          {o.reviews.inProgress ? `, ${count(o.reviews.inProgress)} in progress` : ''}.
        </p>
      </header>

      <section aria-labelledby="funnel">
        <h2 id="funnel" className="mb-5 text-[19px] font-bold">Where findings go</h2>
        <Funnel stages={funnel(o)} />
      </section>

      <section aria-labelledby="per-day">
        <h2 id="per-day" className="mb-3 text-[19px] font-bold">Reviews per day, last 30 days</h2>
        <DayBars days={o.perDay} />
      </section>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        <Facts
          title="The second look"
          intro="Each finding checked again against the code, before anything is posted."
          rows={[
            ['Confirmed', count(o.findings.verdicts.confirmed)],
            ['Unsure, shown but not posted', count(o.findings.verdicts.unsure)],
            ['No verdict', count(o.findings.verdicts.unverified)],
            ['Refuted and dropped', count(refuted)],
            ['Refuted, of all checked', percent(refuted, checked)],
          ]}
        />
        <Facts
          title="What people thought"
          intro="👍 and 👎 on the comments the reviewer posted."
          rows={[
            ['Comments on GitHub', count(o.feedback.posted)],
            ['With a reaction', `${count(o.feedback.withFeedback)} (${percent(o.feedback.withFeedback, o.feedback.posted)})`],
            ['👍 at least once', count(o.feedback.upvoted)],
            ['👎 at least once', count(o.feedback.downvoted)],
            ['Resolved by the reviewer', count(o.findings.resolved.byApp)],
            ['Resolved by a person', count(o.findings.resolved.byPerson)],
          ]}
        />
        <Facts
          title="The agent"
          intro={o.agent.reviews ? 'Reviews an AI model answered.' : 'No AI reviews yet — the stub reviewer has done them all.'}
          rows={[
            ['Reviews', count(o.agent.reviews)],
            ['Average time', duration(o.agent.averageSeconds)],
            ['Average turns', o.agent.averageTurns === null ? '—' : String(o.agent.averageTurns)],
            ['Tokens in / out', `${tokens(o.agent.tokensIn)} / ${tokens(o.agent.tokensOut)}`],
            ['Cost', money(o.agent.costUsd)],
          ]}
        />
      </div>
    </div>
  );
}

function Facts({ title, intro, rows }: { title: string; intro: string; rows: [string, string][] }) {
  return (
    <section>
      <h2 className="text-[19px] font-bold">{title}</h2>
      <p className="mt-1 text-[13px] text-muted">{intro}</p>
      <dl className="mt-3 border-t border-rule">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 border-b border-rule-soft py-2">
            <dt className="text-ink-2">{label}</dt>
            <dd className="font-bold">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
