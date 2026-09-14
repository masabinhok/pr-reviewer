import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AgentReviewer } from './agent-reviewer.js';
import type { InstallationTokenService } from '../github/installation-token.service.js';
import { parseDiff } from '../diff/parse-diff.js';
import { LineMap } from '../diff/line-map.js';
import { filterDiffFiles, filterFileList } from '../filters/review-filter.js';
import { validateFindings } from './validate-findings.js';
import type { PullRequestFile } from '../github/github-api.service.js';

/**
 * The API's half of the cross-language contract (see contracts/README.md): the request is
 * generated here by the real AgentReviewer from a real testbed PR and must match the
 * committed file the agent's tests validate; the response file the agent's tests generate
 * must map cleanly back through AgentReviewer and validateFindings.
 */

const contract = (name: string) => fileURLToPath(new URL(`../../../../contracts/${name}`, import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), 'utf8');

const sync = JSON.parse(fixture('pull_request.synchronize.json'));
const files = JSON.parse(fixture('diffs/pr3-synchronize.files.json')) as PullRequestFile[];
const listed = filterFileList(files);
const kept = filterDiffFiles(parseDiff(fixture('diffs/pr3-synchronize.diff')), new Set(listed.kept.map((f) => f.filename))).kept;
const lines = new LineMap(kept);

function reviewer(): { reviewer: AgentReviewer; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn().mockImplementation(
    async () => new Response(readFileSync(contract('review-response.json')), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const config = {
    getOrThrow: (key: string) => ({ 'agent.url': 'http://agent.test', 'agent.sharedSecret': 's', 'agent.timeoutMs': 1000 })[key],
  } as unknown as ConfigService;
  const tokens = { getToken: async () => 'ghs_placeholder_for_tests' } as unknown as InstallationTokenService;
  return { reviewer: new AgentReviewer(config, tokens), fetchMock };
}

describe('API ↔ agent contract', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const review = (r: AgentReviewer) =>
    r.review({
      installationId: BigInt(sync.installation.id),
      repo: sync.repository.full_name,
      prNumber: sync.number,
      title: 'Diff shapes',
      body: 'Exercises every diff shape the pr-reviewer parser must handle (M10/M11).',
      baseSha: sync.pull_request.base.sha,
      headSha: sync.pull_request.head.sha,
      files: kept,
      lines,
    });

  it('sends exactly the request the agent’s tests validate', async () => {
    const { reviewer: r, fetchMock } = reviewer();

    await review(r);

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    if (process.env.UPDATE_CONTRACT) {
      writeFileSync(contract('review-request.json'), JSON.stringify(sent, null, 2) + '\n');
    }
    expect(sent).toEqual(JSON.parse(readFileSync(contract('review-request.json'), 'utf8')));
  });

  it('understands the response the agent’s models produce', async () => {
    const { reviewer: r } = reviewer();

    const result = await review(r);

    expect(result.run).toMatchObject({ model: 'claude-opus-5', outcome: 'submitted', turns: 6, toolCalls: 5, verifyCalls: 4 });
    expect(result.dropped).toEqual([expect.objectContaining({ finding: expect.objectContaining({ file: 'src/auth.ts', line: 20 }) })]);
    expect(result.run?.usage.costUsd).toBeCloseTo(0.0921);
    // Every finding in the agent's sample is on a real line of that PR, so all survive.
    const { accepted, dropped } = validateFindings(result.findings, lines);
    expect(dropped).toEqual([]);
    expect(accepted.map((f) => [f.path, f.line, f.severity, f.verdict])).toEqual([
      ['src/auth.ts', 26, 'HIGH', 'CONFIRMED'],
      ['src/new-feature.ts', 2, 'MEDIUM', 'CONFIRMED'],
      ['src/helpers.ts', 10, 'LOW', 'UNSURE'],
    ]);
  });
});
