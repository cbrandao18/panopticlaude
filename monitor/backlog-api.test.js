const { test } = require('node:test');
const assert = require('node:assert/strict');
const { backlogData, createBacklogReader } = require('./backlog-api');

const NOW = Date.parse('2026-11-11T22:40:00-05:00');
const status = {
  at: '2026-11-11T22:32:02-05:00', total: 4, remaining: 2,
  counts: { ready: 1, done: 1, triage: 1, unowned: 1 },
  tiers: [], needsYou: [], questions: [], remainingTickets: [],
  history: [
    { date: '2026-11-07', counts: { triage: 3, ready: 1 }, baseline: true },
    { date: '2026-11-11', counts: { ready: 1, done: 1, triage: 1, unowned: 1 } }
  ]
};

test('backlogData reads the VM status file and turns history into still-to-sort counts', async () => {
  let script;
  const d = await backlogData(async (s) => ((script = s), JSON.stringify(status)), NOW);
  assert.match(script, /backlog-pass\/status\.json/);
  assert.deepEqual(d.trend, [{ date: '2026-11-07', remaining: 3, total: 4, baseline: true }, { date: '2026-11-11', remaining: 2, total: 4, baseline: false }]);
  assert.equal(d.stale, false);
  // The hourly timer stopped: older than 3 hours.
  assert.equal((await backlogData(async () => JSON.stringify({ ...status, at: '2026-11-11T18:00:00-05:00' }), NOW)).stale, true);
});

test('the reader reports a missing status file instead of throwing', async () => {
  const read = createBacklogReader({ host: async () => '' });
  const d = await read();
  assert.match(d.error, /No backlog status yet/);
});

const { answer } = require('./backlog-api');
const open = { needsYou: [{ section: 'Dev team unclear', tickets: [{ number: 26539 }] }], answered: [], tiers: [], remainingTickets: [],
  questions: [{ text: 'May the pass close obsolete tickets?' }] };

function fakes() {
  const calls = { gh: [], host: [] };
  return {
    calls,
    run: async (cmd, args) => (calls.gh.push(args), { stdout: args[0] === 'issue' && args[1] === 'comment' ? 'https://github.com/gobranch/branch/issues/26539#issuecomment-1\n' : 'https://github.com/gobranch/branch/actions/runs/9\n' }),
    host: async (script) => (calls.host.push(script), ''),
    read: async () => open,
    now: () => new Date('2026-11-12T14:00:00-05:00')
  };
}
const recorded = (script) => JSON.parse(Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(script)[1], 'base64').toString());

test('picking a dev team dispatches the field workflow live and records the answer on the VM', async () => {
  const f = fakes();
  const r = await answer({ number: 26539, action: 'team', value: 'Staff', note: 'staff-fe owns the cron' }, f);
  assert.deepEqual(f.calls.gh[0], ['workflow', 'run', 'branch-tech-update-fields.yml', '-R', 'gobranch/branch',
    '-f', 'changes=[{"issue":26539,"fields":{"Dev Team":"Staff"}}]', '-f', 'dry_run=false']);
  const line = recorded(f.calls.host[0]);
  assert.deepEqual([line.number, line.action, line.value, line.note, line.url], [26539, 'team', 'Staff', 'staff-fe owns the cron', 'https://github.com/gobranch/branch/actions/runs/9']);
  assert.match(f.calls.host[0], /decisions\.jsonl/);
  assert.match(f.calls.host[0], /systemctl --user start --no-block backlog-status\.service/);
  assert.equal(r.url, 'https://github.com/gobranch/branch/actions/runs/9');
});

test('closing posts her exact comment with the close, and a note stays private', async () => {
  const f = fakes();
  await answer({ number: 26539, action: 'close', value: 'not planned', comment: 'Shipped in #30693.' }, f);
  assert.deepEqual(f.calls.gh[0], ['issue', 'close', '26539', '-R', 'gobranch/branch', '--reason', 'not planned', '--comment', 'Shipped in #30693.']);
  const g = fakes();
  await answer({ number: 26539, action: 'note', note: 'Ask Dave first' }, g);
  assert.deepEqual(g.calls.gh, []);
  assert.equal(recorded(g.calls.host[0]).note, 'Ask Dave first');
});

test('a comment action posts as a ticket comment; a question answer records without touching GitHub', async () => {
  const f = fakes();
  const r = await answer({ number: 26539, action: 'comment', comment: 'Decision: 59 months.' }, f);
  assert.deepEqual(f.calls.gh[0], ['issue', 'comment', '26539', '-R', 'gobranch/branch', '--body', 'Decision: 59 months.']);
  assert.equal(r.url, 'https://github.com/gobranch/branch/issues/26539#issuecomment-1');
  const g = fakes();
  await answer({ action: 'question', question: 'May the pass close obsolete tickets?', value: 'yes' }, g);
  assert.deepEqual([g.calls.gh, recorded(g.calls.host[0]).value], [[], 'yes']);
});

test('answers outside the backlog or with unknown values are refused before anything runs', async () => {
  for (const bad of [
    { number: 1, action: 'skip' },
    { number: 26539, action: 'team', value: 'Mutuals' },
    { number: 26539, action: 'close', value: 'whatever' },
    { number: 26539, action: 'comment', comment: '' },
    { number: 26539, action: 'delete' },
    { action: 'question', question: 'Not asked', value: 'yes' }
  ]) {
    const f = fakes();
    await assert.rejects(answer(bad, f), (e) => e.status === 400);
    assert.deepEqual([f.calls.gh, f.calls.host], [[], []]);
  }
});
