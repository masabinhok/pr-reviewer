import { severityLabel, statusLabel, verdictLabel } from '@/lib/format';

const SEVERITY: Record<string, string> = {
  HIGH: 'text-[var(--high)] bg-[var(--high-bg)]',
  MEDIUM: 'text-[var(--medium)] bg-[var(--medium-bg)]',
  LOW: 'text-[var(--low)] bg-[var(--low-bg)]',
};

/** Severity: a reserved colour, always with its word — never colour alone. */
export function SeverityTag({ severity, demotedFrom }: { severity: string; demotedFrom?: string | null }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-bold ${SEVERITY[severity.toUpperCase()] ?? SEVERITY.LOW}`}>
      {severityLabel(severity.toUpperCase())}
      {demotedFrom ? <span className="font-normal">(was {severityLabel(demotedFrom).toLowerCase()})</span> : null}
    </span>
  );
}

/** The second look's verdict, with a mark that works in greyscale too. */
export function VerdictTag({ verdict }: { verdict: string | null }) {
  const mark = verdict === 'CONFIRMED' ? '✓' : verdict === 'UNSURE' || verdict === 'UNVERIFIED' ? '?' : '–';
  const tone = verdict === 'CONFIRMED' ? 'text-[var(--good)]' : 'text-muted';
  return (
    <span className={`inline-flex items-center gap-1 text-[13px] ${tone}`}>
      <span aria-hidden="true" className="font-bold">
        {mark}
      </span>
      {verdictLabel(verdict)}
    </span>
  );
}

const STATUS: Record<string, string> = {
  COMPLETED: 'text-ink-2',
  FAILED: 'text-[var(--high)] font-bold',
  SKIPPED: 'text-muted',
  RUNNING: 'text-accent',
  PENDING: 'text-muted',
};

export function StatusText({ status }: { status: string }) {
  return <span className={STATUS[status] ?? 'text-ink-2'}>{statusLabel(status)}</span>;
}
