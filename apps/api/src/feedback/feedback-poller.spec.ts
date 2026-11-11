import { signalsByUser } from './feedback-poller.js';
import { FeedbackSignal } from '../generated/prisma/client.js';
import type { Reaction } from '../github/github-api.service.js';

const at = (minute: number) =>
  new Date(`2026-09-17T10:${String(minute).padStart(2, '0')}:00Z`);
const reaction = (
  content: string,
  userId: number,
  minute: number,
  type = 'User',
): Reaction => ({
  content,
  createdAt: at(minute),
  user: { id: BigInt(userId), type },
});

describe('signalsByUser', () => {
  it('reads 👍 as UP and 👎 as DOWN, with when', () => {
    const signals = signalsByUser([reaction('+1', 1, 1), reaction('-1', 2, 2)]);

    expect([...signals]).toEqual([
      [1n, { signal: FeedbackSignal.UP, reactedAt: at(1) }],
      [2n, { signal: FeedbackSignal.DOWN, reactedAt: at(2) }],
    ]);
  });

  it('ignores every other reaction — they say nothing about whether the comment was right', () => {
    const contents = ['laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'];

    expect(
      signalsByUser(contents.map((c, i) => reaction(c, i + 1, i))).size,
    ).toBe(0);
  });

  it('does not count bots, this App included', () => {
    expect(signalsByUser([reaction('+1', 99, 1, 'Bot')]).size).toBe(0);
  });

  // GitHub lets one person leave both; what they think now is their latest.
  it('keeps one signal per person: the latest of their 👍 and 👎', () => {
    const changedMind = signalsByUser([
      reaction('+1', 1, 1),
      reaction('-1', 1, 5),
    ]);
    const changedBack = signalsByUser([
      reaction('-1', 1, 5),
      reaction('+1', 1, 9),
    ]);

    expect(changedMind.get(1n)?.signal).toBe(FeedbackSignal.DOWN);
    expect(changedBack.get(1n)?.signal).toBe(FeedbackSignal.UP);
  });
});

describe('FeedbackPoller rate limits', () => {
  // A rate-limited installation is skipped for the rest of the round; others still get polled.
  it('stops asking for a rate-limited installation, and carries on with the others', async () => {
    const { FeedbackPoller } = await import('./feedback-poller.js');
    const { GithubRateLimitError } =
      await import('../github/github-api.errors.js');
    const finding = (id: string, installation: bigint) => ({
      id,
      githubCommentId: 1n,
      reactionsEtag: null,
      review: {
        repo: { fullName: 'o/r', installation: { githubId: installation } },
      },
    });
    const prisma = {
      finding: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            finding('a1', 1n),
            finding('a2', 1n),
            finding('b1', 2n),
          ]),
      },
    };
    const github = {
      listCommentReactions: vi.fn(async (installation: bigint) => {
        if (installation === 1n)
          throw new GithubRateLimitError('primary', new Date(), '/x');
        return { kind: 'unchanged' };
      }),
    };
    const poller = new FeedbackPoller(prisma as never, github as never);

    const summary = await poller.pollOnce(new Date());

    expect(summary).toMatchObject({ checked: 1, unchanged: 1, rateLimited: 1 });
    expect(github.listCommentReactions).toHaveBeenCalledTimes(2); // a1 (limited), b1 — never a2
  });
});
