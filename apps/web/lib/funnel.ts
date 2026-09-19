import type { Overview } from './api';

export interface Stage {
  key: string;
  label: string;
  value: number;
  /** What happened between the previous stage and this one, in a sentence. */
  note: string;
}

/**
 * Where findings go, from the reviewer's first answer to someone's 👎 — the story of the
 * noise work in weeks 5–8, in the order it happens.
 *
 * "Proposed" is what the reviewer handed in (kept + refuted); the rest is read straight off
 * the overview. Stages only shrink, except the last, which counts reactions to posted ones.
 */
export function funnel(o: Overview): Stage[] {
  const kept = o.findings.total;
  const refuted = o.findings.droppedOnSecondLook;
  const proposed = kept + refuted;
  return [
    { key: 'proposed', label: 'Proposed', value: proposed, note: 'What the reviewer handed in.' },
    { key: 'refuted', label: 'Refuted', value: refuted, note: 'Dropped by the second look: the code showed they were wrong.' },
    { key: 'kept', label: 'Kept', value: kept, note: 'Stored, and listed in the Check Run.' },
    {
      key: 'posted',
      label: 'Posted',
      value: o.findings.posted,
      note: `Commented on the pull request.${repeatsNote(o.findings.repeats)}`,
    },
    { key: 'downvoted', label: 'Marked wrong', value: o.feedback.downvoted, note: 'Given a 👎 by someone on GitHub.' },
  ];
}

function repeatsNote(repeats: number): string {
  if (repeats === 0) return '';
  return ` ${repeats} more ${repeats === 1 ? 'was' : 'were'} already there from an earlier push.`;
}
