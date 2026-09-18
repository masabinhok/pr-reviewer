import type { Stage } from '@/lib/funnel';
import { count } from '@/lib/format';

/**
 * The page's one bold element: where findings go, left to right, each stage's bar in
 * proportion to the first. A real sequence, so the arrows between stages are honest.
 */
export function Funnel({ stages }: { stages: Stage[] }) {
  const top = Math.max(stages[0]?.value ?? 0, 1);
  return (
    <ol className="grid grid-cols-1 gap-x-3 gap-y-5 sm:grid-cols-2 lg:grid-cols-5" aria-label="Where findings go">
      {stages.map((stage, i) => (
        <li key={stage.key} className="relative min-w-0">
          <p className="text-[34px] font-bold leading-none tracking-tight text-ink">{count(stage.value)}</p>
          <p className="mt-2 flex items-baseline gap-2 font-bold text-ink">
            {stage.label}
            {i < stages.length - 1 ? (
              <span aria-hidden="true" className="hidden font-normal text-muted lg:inline">
                ›
              </span>
            ) : null}
          </p>
          <div className="mt-2 h-2 w-full rounded-sm bg-rule-soft" aria-hidden="true">
            <div className="h-2 rounded-sm bg-mark" style={{ width: `${Math.min(100, (stage.value / top) * 100)}%` }} />
          </div>
          <p className="mt-2 text-[13px] leading-snug text-muted">{stage.note}</p>
        </li>
      ))}
    </ol>
  );
}
