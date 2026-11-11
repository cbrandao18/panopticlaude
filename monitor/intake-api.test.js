const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readIntake, summarize, outcome, reviewCache, MAX_REVIEWED_RUNS } = require('./intake-api');
const { assemble } = require('./now-api');

const NOW = Date.parse('2026-11-11T20:00:00Z');
const ghRun = (id, over = {}) => ({
  databaseId: id, event: 'issues', status: 'completed', conclusion: 'success', createdAt: '2026-11-11T19:00:00Z',
  displayTitle: `Ticket ${id}`, url: `https://github.com/gobranch/branch/actions/runs/${id}`, ...over
});
const RUNS = [
  ghRun(1),
  ghRun(2, { conclusion: 'skipped', event: 'issue_comment' }),
  ghRun(3, { conclusion: 'failure' }),
  ghRun(4, { status: 'in_progress', conclusion: '' }),
  ghRun(5, { createdAt: '2026-11-10T19:00:00Z' })
];
const DEPRECATED = { message: "Input 'app-id' has been deprecated with message: Use 'client-id' instead." };

// A fake gh: answers by argv, records every call.
function fakeGh({ live = 'true\n', runs = RUNS, variableError = null } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'variable') {
      if (variableError) throw Object.assign(new Error('exit 1'), { stderr: variableError });
      return { stdout: live };
    }
    if (args[0] === 'run' && args[1] === 'list') return { stdout: JSON.stringify(runs) };
    if (args[0] === 'run' && args[1] === 'view') {
      const id = Number(args[2]);
      return { stdout: JSON.stringify({ jobs: [
        { databaseId: id * 10, name: 'context', conclusion: 'success' },
        { databaseId: id * 10 + 1, name: 'apply', conclusion: id === 3 ? 'failure' : 'success' }
      ] }) };
    }
    if (args[0] === 'api') {
      const job = Number(/check-runs\/(\d+)\//.exec(args[1])[1]);
      return { stdout: JSON.stringify(job === 11 ? [DEPRECATED, { message: '#38751: 2 item(s) need review; see the job summary' }] : [DEPRECATED]) };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { run, calls };
}

beforeEach(() => reviewCache.clear());

test('outcome groups failures and in-progress runs', () => {
  assert.equal(outcome(ghRun(1, { conclusion: 'timed_out' })), 'failed');
  assert.equal(outcome(ghRun(1, { status: 'queued', conclusion: '' })), 'running');
  assert.equal(outcome(ghRun(1, { conclusion: 'cancelled' })), 'cancelled');
});

test('readIntake counts the last 24 hours and reads needs-review annotations from finished runs only', async () => {
  const gh = fakeGh();
  const card = summarize(await readIntake(gh.run, NOW));
  assert.equal(card.live, true);
  assert.deepEqual(card.counts, { success: 1, skipped: 1, failed: 1, running: 1 });
  assert.deepEqual(card.failed.map((r) => r.title), ['Ticket 3']);
  assert.deepEqual(card.reviews, [{ issue: 38751, items: 2, url: 'https://github.com/gobranch/branch/actions/runs/1', at: Date.parse('2026-11-11T19:00:00Z') }]);
  // Skipped, in-progress and older-than-24h runs get no job lookup.
  assert.deepEqual(gh.calls.filter((c) => c.startsWith('run view')).map((c) => c.split(' ')[2]).sort(), ['1', '3']);
  // A completed run is read once; the next refresh only lists runs.
  const before = gh.calls.length;
  await readIntake(gh.run, NOW);
  assert.equal(gh.calls.length - before, 2);
});

test('readIntake calls anything but exactly "true" a dry run, and a missing variable too', async () => {
  assert.equal((await readIntake(fakeGh({ live: 'false\n' }).run, NOW)).live, false);
  assert.equal((await readIntake(fakeGh({ live: 'TRUE\n' }).run, NOW)).live, false);
  const missing = await readIntake(fakeGh({ variableError: 'variable AI_INTAKE_LIVE was not found' }).run, NOW);
  assert.deepEqual([missing.live, missing.liveValue], [false, '']);
  await assert.rejects(readIntake(fakeGh({ variableError: 'HTTP 401: Bad credentials' }).run, NOW), /exit 1/);
});

test('readIntake checks at most MAX_REVIEWED_RUNS finished runs', async () => {
  const runs = Array.from({ length: MAX_REVIEWED_RUNS + 3 }, (_, i) => ghRun(100 + i));
  const gh = fakeGh({ runs });
  const card = summarize(await readIntake(gh.run, NOW));
  assert.equal(gh.calls.filter((c) => c.startsWith('run view')).length, MAX_REVIEWED_RUNS);
  assert.equal(card.unchecked, 3);
});

test('assemble puts failed intake runs on Down, not skipped ones, and reports an unreadable intake', async () => {
  const base = { automations: { value: [] }, statuses: { value: [] }, reviews: { value: [] }, map: { value: { hosts: [] } }, ease: { value: {} },
    merge: { value: { ready: [], waiting: [] } }, releases: { value: [] }, findings: { value: null }, jobs: { value: [] } };
  const out = assemble({ ...base, intake: { value: await readIntake(fakeGh().run, NOW) } });
  assert.deepEqual(out.down.map((d) => [d.title, d.url]), [['New-ticket intake run failed: Ticket 3', 'https://github.com/gobranch/branch/actions/runs/3']]);
  assert.equal(out.intake.reviews.length, 1);
  assert.deepEqual(out.attention.failed.map(r => r.url), ['https://github.com/gobranch/branch/actions/runs/3']);
  const broken = assemble({ ...base, intake: { error: 'gh: not logged in' } });
  assert.deepEqual([broken.intake, broken.intakeError], [null, 'gh: not logged in']);
  assert.ok(broken.errors.some((e) => e.source === 'intake'));
});
