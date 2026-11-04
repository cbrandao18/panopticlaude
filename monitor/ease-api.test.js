const { test } = require('node:test');
const assert = require('node:assert/strict');
const { easeData, fileTicket, ticketFromDraft } = require('./ease-api');
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

- Requester: Pat Example, Support Lead (Member Support)
- Priority: **Medium**.

## Paste-ready ticket draft

**Title:** Area - Thing: sample ticket title

### Describe the problem or pain point you are experiencing. Why is this a problem?

Sample problem. https://team-branch.slack.com/archives/C02MK5V05CJ/p2222000002

### Requested By

Member Support
`;

const map = async () => ({ hosts: [{ workspaces: [
  { path: '/w/ease-3333000003', name: '#90 Sample fix', comment: 'Agent: clear' },
  { path: '/w/ease-5555000005', name: 'Ease · 5555.000005', comment: 'Assessing' }
] }] });

test('builds one tree per post with whose move it is', async () => {
  const data = await easeData({ source: async () => SOURCE, readMap: map, ghStates: async () => ({ 90: { state: 'OPEN', isDraft: true } }) });
  const by = Object.fromEntries(data.posts.map((p) => [p.ts, p]));

  assert.equal(by['1111.000001'].outcome, 'skipped');
  assert.equal(by['1111.000001'].whose, 'closed');

  assert.equal(by['2222.000002'].whose, 'you');
  assert.equal(by['2222.000002'].title, 'Sample ask title');
  assert.equal(by['2222.000002'].priority, 'Medium');
  assert.deepEqual(by['2222.000002'].actions.map((a) => a.state), ['open', 'unknown']);
  assert.equal(by['2222.000002'].actions[0].ticket.title, 'Area - Thing: sample ticket title');
  assert.doesNotMatch(by['2222.000002'].actions[0].ticket.body, /Sample ask title|Priority/);

  assert.equal(by['3333.000003'].title, '#90 Sample fix');
  assert.equal(by['3333.000003'].actions[0].text, 'Dev deploy and live check, then mark the PR ready');

  assert.equal(by['4444.000004'].actions[0].state, 'done', 'removed from todo.md means decided');
  assert.equal(by['4444.000004'].whose, 'closed');

  assert.equal(by['5555.000005'].whose, 'agent');
  assert.match(by['5555.000005'].title, /^Suggestion posted /);

  assert.deepEqual(data.posts.map((p) => p.whose).slice(0, 2), ['you', 'you']);
});

test('summary carries verdict, reason without the file path, requester and reply status', async () => {
  const data = await easeData({ source: async () => SOURCE, ghStates: async () => ({}) });
  const by = Object.fromEntries(data.posts.map((p) => [p.ts, p.summary]));
  assert.deepEqual(by['2222.000002'], { requester: 'Pat Example, Support Lead (Member Support)', verdict: 'not-easy', reason: 'needs a product call', replyDraft: 'saved' });
  assert.equal(by['3333.000003'].verdict, 'easy');
  assert.equal(by['1111.000001'].verdict, 'skipped');
  assert.equal(by['1111.000001'].reason, 'already ticketed as #1');
  assert.equal(by['1111.000001'].requester, null);
});

test('parse keeps the first draft when todo.md has no ease lines', () => {
  const { drafts, todo } = require('./ease-api').parse('2026-11-01T09:00:00-0500 started 1.2: x\n@@TODO\n@@DRAFT todo/ease-12.md\n# T\n- Requester: A\n');
  assert.deepEqual(todo, []);
  assert.match(drafts['12'], /Requester: A/);
});

test('merged PRs close the post', async () => {
  const data = await easeData({ source: async () => SOURCE, ghStates: async () => ({ 90: { state: 'MERGED', isDraft: false } }) });
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

test('ticketFromDraft takes the title line and the ### fields', () => {
  const t = ticketFromDraft(SOURCE.split('@@DRAFT todo/ease-2222000002.md\n')[1]);
  assert.equal(t.title, 'Area - Thing: sample ticket title');
  assert.match(t.body, /^### Describe the problem/);
  assert.match(t.body, /### Requested By\n\nMember Support$/);
  assert.equal(ticketFromDraft('# no ticket section'), null);
  const plain = ticketFromDraft('# H1 title\n\n## Paste-ready ticket draft (02-stakeholder-request)\n\nTitle: Plain title\n\n### OKR\n\nx\n');
  assert.deepEqual(plain, { title: 'Plain title', body: '### OKR\n\nx' });
  const fenced = ticketFromDraft('# H1 title\n\n## Paste-ready ticket draft\n\n```\n### OKR\n\nx\n```\n');
  assert.deepEqual(fenced, { title: 'H1 title', body: '### OKR\n\nx' });
});

test('fileTicket files a Story, logs it and drops the todo line', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    if (args[0] === 'search') return { stdout: '[]' };
    return { stdout: JSON.stringify({ number: 123, html_url: 'https://github.com/gobranch/branch/issues/123' }) };
  };
  let script = '';
  const result = await fileTicket('2222.000002', { source: async () => SOURCE, host: async (s) => { script = s; }, run });
  assert.deepEqual(result, { url: 'https://github.com/gobranch/branch/issues/123', number: 123 });
  const create = calls.find((a) => a[0] === 'api');
  assert.ok(create.includes('title=Area - Thing: sample ticket title') && create.includes('type=Story'));
  assert.match(script, /filed 2222\.000002: #123 https:\/\/github\.com\/gobranch\/branch\/issues\/123/);
  assert.match(script, /grep -v 'todo\/ease-2222000002\\.md' todo\.md/);
});

test('fileTicket refuses posts already on GitHub, already filed, or without a draft', async () => {
  const run = async () => ({ stdout: '[{"url":"https://github.com/gobranch/branch/issues/9"}]' });
  await assert.rejects(fileTicket('2222.000002', { source: async () => SOURCE, host: async () => {}, run }), { status: 409, message: /issues\/9/ });
  const filed = SOURCE.replace('@@TODO', '2026-11-02T10:00:00-0500 filed 2222.000002: #5 https://github.com/gobranch/branch/issues/5\n@@TODO');
  await assert.rejects(fileTicket('2222.000002', { source: async () => filed, run }), { status: 409 });
  await assert.rejects(fileTicket('4444.000004', { source: async () => SOURCE, run }), { status: 404 });
  await assert.rejects(fileTicket('x; rm -rf ~', { source: async () => SOURCE, run }), { status: 400 });
});

test('a filed ticket closes the decide action', async () => {
  const filed = SOURCE.replace('@@TODO', '2026-11-02T10:00:00-0500 filed 2222.000002: #5 https://github.com/gobranch/branch/issues/5\n@@TODO');
  const data = await easeData({ source: async () => filed, ghStates: async () => ({ 5: { state: 'OPEN', title: 'Area - Thing: sample ticket title' } }) });
  const post = data.posts.find((p) => p.ts === '2222.000002');
  assert.deepEqual(post.actions[0], { text: 'Filed Area - Thing: sample ticket title', state: 'done', url: 'https://github.com/gobranch/branch/issues/5' });
  assert.deepEqual(post.events.find((e) => e.kind === 'filed').link, { url: 'https://github.com/gobranch/branch/issues/5', title: 'Area - Thing: sample ticket title' });
});

test('/api/ease/file requires the monitor header and files once', async (t) => {
  const filed = [];
  const server = createMonitor({ jobs: [], readMap: async () => ({ hosts: [] }), readEase: async () => ({ posts: [] }), fileEase: async (ts) => { filed.push(ts); return { number: 1 }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/ease/file`;
  const body = JSON.stringify({ ts: '1.2' });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1', Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' }, body })).status, 201);
  assert.deepEqual(filed, ['1.2']);
});

test('/api/open opens only GitHub and Slack https links', async (t) => {
  const opened = [];
  const server = createMonitor({ jobs: [], readMap: async () => ({ hosts: [] }), readEase: async () => ({ posts: [] }), openUrl: async (u) => { opened.push(u); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const post = (url, headers = { 'X-Panopticlaude': '1' }) => fetch(`http://127.0.0.1:${server.address().port}/api/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ url })
  }).then((r) => r.status);
  assert.equal(await post('https://github.com/gobranch/branch/issues/5'), 200);
  assert.equal(await post('https://team-branch.slack.com/archives/C1/p1'), 200);
  assert.equal(await post('https://github.com/x', {}), 403);
  assert.equal(await post('file:///etc/passwd'), 400);
  assert.equal(await post('https://evil.example/github.com'), 400);
  assert.equal(await post('-a Calculator'), 400);
  assert.deepEqual(opened, ['https://github.com/gobranch/branch/issues/5', 'https://team-branch.slack.com/archives/C1/p1']);
});
