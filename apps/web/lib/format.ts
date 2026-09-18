/** Formatting shared by every page. Pure, so it is tested without a server. */

const number = new Intl.NumberFormat('en-US');

export const count = (n: number) => number.format(n);

/** "12s", "2m 10s", "1h 4m" — a review's length, read at a glance. */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** 21362 → "21.4k"; small numbers as they are. */
export function tokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Local models cost nothing, and saying "$0.00" is more honest than a dash. */
export function money(usd: number | null): string {
  if (usd === null) return '—';
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** A share, or a dash when there is nothing to take a share of. */
export function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** "3 hours ago", "yesterday", "12 Sep" — relative to `now` so it can be tested. */
export function ago(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.round((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** How a review ended, in words a person would use. */
export function statusLabel(status: string): string {
  return (
    { COMPLETED: 'Reviewed', FAILED: 'Failed', SKIPPED: 'Too large to review', RUNNING: 'Reviewing', PENDING: 'Waiting' }[status] ?? status
  );
}

export function severityLabel(severity: string): string {
  return severity.charAt(0) + severity.slice(1).toLowerCase();
}

/** The agent's second look, as a person would say it. */
export function verdictLabel(verdict: string | null): string {
  if (verdict === null) return 'Not checked';
  return { CONFIRMED: 'Confirmed', UNSURE: 'Unsure', UNVERIFIED: 'No verdict' }[verdict] ?? verdict;
}
