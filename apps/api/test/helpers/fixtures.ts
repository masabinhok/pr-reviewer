import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads a captured delivery as the exact string GitHub sent. Tests send this string
 * rather than a re-serialised object, because the signature covers the bytes — see the
 * raw-body entry in docs/decisions.md.
 */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)), 'utf8');
}

export function fixtureJson<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}
