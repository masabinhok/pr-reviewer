import { buildFixture, commitsToReview } from './build-fixture.js';
import { draftBugs, isReviewableSource } from './fixture.js';
import { parseDiff } from '../diff/parse-diff.js';

// jshttp/cookie 24f7da0 "Fix for maxAge == 0", as `git diff <fix> <parent>` prints it: the fix
// reversed, with the fix's test and changelog alongside the source.
const FIX = 'f'.repeat(40);
const PARENT = 'a'.repeat(40);
const REVERSED = `diff --git a/index.js b/index.js
index 1111111..2222222 100644
--- a/index.js
+++ b/index.js
@@ -14,12 +14,7 @@ var serialize = function(name, val, opt){
     var enc = opt.encode || encode;
     var pairs = [name + '=' + enc(val)];
 
-    if (null != opt.maxAge) {
-        var maxAge = opt.maxAge - 0;
-        if (isNaN(maxAge)) throw new Error('maxAge should be convertable to Number');
-        pairs.push('Max-Age=' + maxAge);
-    }
-
+    if (opt.maxAge) pairs.push('Max-Age=' + opt.maxAge);
     if (opt.domain) pairs.push('Domain=' + opt.domain);
     if (opt.path) pairs.push('Path=' + opt.path);
     if (opt.expires) pairs.push('Expires=' + opt.expires.toUTCString());
diff --git a/test/serialize.js b/test/serialize.js
index 3333333..4444444 100644
--- a/test/serialize.js
+++ b/test/serialize.js
@@ -40,6 +40,0 @@ test('maxAge', function() {
-    assert.equal('foo=bar; Max-Age=0', cookie.serialize('foo', 'bar', { maxAge: 0 }));
-    assert.equal('foo=bar; Max-Age=1000', cookie.serialize('foo', 'bar', { maxAge: 1000 }));
-    assert.throws(function() {
-        cookie.serialize('foo', 'bar', { maxAge: 'buzz' });
-    }, /maxAge should be convertable to Number/);
-
diff --git a/History.md b/History.md
index 5555555..6666666 100644
--- a/History.md
+++ b/History.md
@@ -1,3 +1,0 @@
-unreleased
-
-  * Fix for maxAge == 0
`;

const input = { id: 'cookie-maxage-zero', kind: 'bug' as const, split: 'tune' as const, repo: 'jshttp/cookie', commit: FIX, parent: PARENT, message: 'Fix for maxAge == 0', diff: REVERSED };

describe('buildFixture', () => {
  it('reviews a fix backwards: from the fixed code to the code before it', () => {
    expect(commitsToReview('bug', FIX, PARENT)).toEqual({ base: FIX, head: PARENT });
    expect(commitsToReview('clean', FIX, PARENT)).toEqual({ base: PARENT, head: FIX });
  });

  // The regression test and the changelog entry would hand the reviewer the answer.
  it('keeps only source files — no tests, no changelog', () => {
    const fixture = buildFixture(input);

    expect(fixture.request.files.map((f) => f.path)).toEqual(['index.js']);
  });

  it('gives the pull request a neutral title that does not name the bug', () => {
    const fixture = buildFixture(input);

    expect(fixture.request.title).toBe('Update index.js');
    expect(fixture.request.body).toBe('');
    expect(JSON.stringify(fixture.request)).not.toContain('maxAge == 0');
  });

  it('drafts the key at the lines the fix changed, for a person to describe', () => {
    const [bug] = buildFixture(input).bugs;

    expect(bug).toMatchObject({ file: 'index.js', head: [17, 17], base: [17, 22] });
    expect(bug.description).toContain('TODO');
  });

  it('records where it came from, and reviews the right commits', () => {
    const fixture = buildFixture(input);

    expect(fixture.source).toEqual({ repo: 'jshttp/cookie', commit: FIX, url: `https://github.com/jshttp/cookie/commit/${FIX}`, message: 'Fix for maxAge == 0' });
    expect([fixture.request.baseSha, fixture.request.headSha]).toEqual([FIX, PARENT]);
  });

  it('makes a clean fixture with no bugs', () => {
    expect(buildFixture({ ...input, kind: 'clean' }).bugs).toEqual([]);
  });

  it('refuses a change with nothing left to review', () => {
    const docsOnly = REVERSED.slice(REVERSED.indexOf('diff --git a/test/'));

    expect(() => buildFixture({ ...input, diff: docsOnly })).toThrow('no reviewable source files');
  });
});

describe('draftBugs', () => {
  // A fix that only added code reverses into a pure deletion: point at where the code was.
  it('anchors a pure deletion at the head line just above it', () => {
    const deletion = parseDiff(`diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -10,5 +10,3 @@ def f():
     x = 1
     y = 2
-    if x > y:
-        raise ValueError()
     return x
`);

    expect(draftBugs(deletion)).toEqual([expect.objectContaining({ file: 'a.py', head: [11, 11], base: [12, 13] })]);
  });
});

describe('isReviewableSource', () => {
  it.each([
    ['src/index.ts', true],
    ['httpx/_auth.py', true],
    ['index.js', true],
    ['test/serialize.js', false],
    ['src/__tests__/a.ts', false],
    ['src/a.test.ts', false],
    ['tests/test_time.py', false],
    ['src/attr/validators.pyi', false],
    ['types/index.d.ts', false],
    ['README.md', false],
    ['docs/guide.py', false],
    ['examples/basic.py', false],
  ])('%s → %s', (path, expected) => {
    expect(isReviewableSource(path)).toBe(expected);
  });
});
