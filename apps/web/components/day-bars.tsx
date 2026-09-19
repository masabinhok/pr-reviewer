import { count } from '@/lib/format';

interface Day {
  day: string;
  reviews: number;
  findings: number;
  posted: number;
}

const WIDTH = 720;
const HEIGHT = 140;
const GAP = 2;

/**
 * Reviews per day over the last 30 days: one series, so no legend — the heading names it.
 * Thin bars anchored to the baseline with rounded tops, a 2px gap between them, a recessive
 * baseline, the first and last day labelled. Each bar has a hover title, and the same numbers
 * are in a table underneath for anyone who can't use the chart.
 */
export function DayBars({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((d) => d.reviews));
  const band = WIDTH / Math.max(days.length, 1);
  const barWidth = Math.max(2, band - GAP);
  const label = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <figure>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT + 1}`} className="block h-auto w-full" role="img" aria-label={`Reviews per day, the last ${days.length} days`}>
        <line x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke="var(--rule)" strokeWidth={1} />
        {days.map((d, i) => {
          const h = d.reviews === 0 ? 0 : Math.max(3, (d.reviews / max) * (HEIGHT - 8));
          const x = i * band + GAP / 2;
          const r = Math.min(4, barWidth / 2, h);
          return (
            <g key={d.day}>
              <rect x={i * band} y={0} width={band} height={HEIGHT} fill="transparent">
                <title>{`${label(d.day)}: ${count(d.reviews)} review${d.reviews === 1 ? '' : 's'}, ${count(d.findings)} findings, ${count(d.posted)} posted`}</title>
              </rect>
              {h > 0 ? (
                <path
                  d={`M${x},${HEIGHT} v${-(h - r)} q0,${-r} ${r},${-r} h${barWidth - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  fill="var(--mark)"
                  pointerEvents="none"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* Outside the SVG, so the dates stay readable when the chart shrinks to a phone's width. */}
      {days.length > 0 ? (
        <div className="mt-1 flex justify-between text-[13px] text-muted" aria-hidden="true">
          <span>{label(days[0].day)}</span>
          <span>{label(days[days.length - 1].day)}</span>
        </div>
      ) : null}
      <details className="mt-2 text-[13px] text-muted">
        <summary className="cursor-pointer">Show as a table</summary>
        <table className="mt-2 w-full max-w-md text-left">
          <thead>
            <tr className="text-ink-2">
              <th className="py-1 font-bold">Day</th>
              <th className="py-1 text-right font-bold">Reviews</th>
              <th className="py-1 text-right font-bold">Findings</th>
              <th className="py-1 text-right font-bold">Posted</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => d.reviews > 0)
              .map((d) => (
                <tr key={d.day} className="border-t border-rule-soft">
                  <td className="py-1">{label(d.day)}</td>
                  <td className="py-1 text-right">{count(d.reviews)}</td>
                  <td className="py-1 text-right">{count(d.findings)}</td>
                  <td className="py-1 text-right">{count(d.posted)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
