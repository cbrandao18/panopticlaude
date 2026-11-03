const { test } = require('node:test');
const assert = require('node:assert/strict');
const { easeData } = require('./ease-api');
const { createMonitor } = require('./server');

const SOURCE = `2026-11-01T09:00:00-0500 skipped 1111.000001: already ticketed as #1
2026-11-01T09:00:05-0500 started 1111.000001: ease-1111000001 (live)
2026-11-01T10:00:00-0500 started 2222.000002: ease-2222000002 (live)
2026-11-01T10:01:00-0500 not-easy 2222.000002: needs a product call (todo/ease-2222000002.md)
2026-11-01T10:01:05-0500 drafted 2222.000002: Slack reply saved
2026-11-01T11:00:00-0500 started 3333.000003: ease-3333000003 (live)
2026-11-01T11:05:00-0500 pr 3333.000003: https://github.com/gobranch/branch/pull/90
2026-11-01T11:20:00-0500 clear 3333.000003: https://github.com/gobranch/branch/pull/90
2026-11-01T12:00:00-0500 started 4444.000004: ease-4444000004 (live)
2026-11-01T12:01:00-0500 not-easy 4444.000004: decided already (todo/ease-4444000004.md)
2026-11-01T13:00:00-0500 started 5555.000005: ease-5555000005 (live)
@@TODO
- 2026-11-01 ease-and-effort (Medium): sample ask is not an easy win. Decide ([draft](/x/todo/ease-2222000002.md))
@@DRAFT todo/ease-2222000002.md
# Sample ask title

- Priority: **Medium**.
`;

const map = async () => ({ hosts: [{ workspaces: [
  { path: '/w/ease-3333000003', name: '#90 Sample fix', comment: 'Agent: clear' },
  { path: '/w/ease-5555000005', name: 'Ease · 5555.000005', comment: 'Assessing' }
] }] });

test('builds one tree per post with whose move it is', async () => {
  const data = await easeData({ source: async () => SOURCE, readMap: map, prStates: async () => ({ 90: { state: 'OPEN', isDraft: true } }) });
  const by = Object.fromEntries(data.posts.map((p) => [p.ts, p]));

  assert.equal(by['1111.000001'].outcome, 'skipped');
  assert.equal(by['1111.000001'].whose, 'closed');

  assert.equal(by['2222.000002'].whose, 'you');
  assert.equal(by['2222.000002'].title, 'Sample ask title');
  assert.equal(by['2222.000002'].priority, 'Medium');
  assert.deepEqual(by['2222.000002'].actions.map((a) => a.state), ['open', 'unknown']);
  assert.match(by['2222.000002'].actions[0].draft, /Sample ask title/);

  assert.equal(by['3333.000003'].title, '#90 Sample fix');
  assert.equal(by['3333.000003'].actions[0].text, 'Dev deploy and live check, then mark the PR ready');

  assert.equal(by['4444.000004'].actions[0].state, 'done', 'removed from todo.md means decided');
  assert.equal(by['4444.000004'].whose, 'closed');

  assert.equal(by['5555.000005'].whose, 'agent');
  assert.match(by['5555.000005'].title, /^Suggestion posted /);

  assert.deepEqual(data.posts.map((p) => p.whose).slice(0, 2), ['you', 'you']);
});

test('merged PRs close the post', async () => {
  const data = await easeData({ source: async () => SOURCE, prStates: async () => ({ 90: { state: 'MERGED', isDraft: false } }) });
  const post = data.posts.find((p) => p.ts === '3333.000003');
  assert.equal(post.actions[0].state, 'done');
  assert.equal(post.whose, 'closed');
});

test('/api/ease serves the reader', async (t) => {
  const server = createMonitor({ jobs: [], readMap: async () => ({ hosts: [] }), readEase: async () => ({ posts: [{ ts: '1.2' }] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ease`);
  assert.equal((await res.json()).posts[0].ts, '1.2');
});
