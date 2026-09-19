import { ApiUnavailable } from '@/lib/api';

/** When there is nothing to show: what went wrong, and what to do. No apology, no mystery. */
export function Problem({ error }: { error: unknown }) {
  const known = error instanceof ApiUnavailable;
  return (
    <div role="alert" className="max-w-xl rounded-md border border-rule bg-panel p-5">
      <p className="font-bold">{known ? error.message : 'The dashboard could not load this page.'}</p>
      <p className="mt-1 text-ink-2">{known ? error.fix : 'Check the API’s log and the dashboard’s terminal for the error.'}</p>
    </div>
  );
}

/** Loads a page's data, or hands back the problem to show instead. */
export async function attempt<T>(load: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: ApiUnavailable }> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    if (error instanceof ApiUnavailable) return { ok: false, error };
    throw error;
  }
}
