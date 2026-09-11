import { Prisma } from '../generated/prisma/client.js';

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Runs `write` once more if it loses a race to a concurrent insert.
 *
 * Prisma's `upsert` is read-then-write: two concurrent upserts of a row that doesn't exist
 * yet can both read "absent" and both insert, and the loser fails with P2002 — on
 * whichever unique index Postgres happens to check first, not necessarily the one in
 * `where`. On the second run the read finds the winner's row and the upsert becomes an
 * update. One retry is enough: the row cannot un-exist between the two runs.
 */
export async function retryOnUniqueViolation<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return write();
  }
}
