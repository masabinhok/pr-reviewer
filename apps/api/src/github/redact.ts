/**
 * `ghs_abc123…` → `ghs_***`. Keeps the prefix because it says what *kind* of token was
 * involved (installation, user, PAT), which is useful in a log line and not a secret.
 */
export function redactToken(token: string): string {
  const prefix = /^(github_pat_|gh[a-z]_)/.exec(token)?.[1] ?? '';
  return `${prefix}***`;
}
