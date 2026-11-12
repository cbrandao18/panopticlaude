const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe, parseRecent, summarize, readSlots } = require('./slots-api');

const NOW = Date.parse('2026-11-10T17:00:00-05:00');
const status = (over = {}) => ({
  at: '2026-11-10T16:59:00-05:00',
  budget: 10,
  used: 3,
  paused: null,
  kinds: {
    review: { prefix: 'review-', weight: 1, most: 4, running: ['review-38647'] },
    bugfix: { prefix: 'bugfix-', weight: 2, most: 3, running: ['bugfix-38599'] }
  },
  queue: [{ position: 1, kind: 'bugfix', key: 'bugfix:38601', priority: 60, workspace: 'bugfix-38601', queuedAt: '2026-11-10T16:30:00-05:00', fitsNow: true }],
  recent: [
    { at: '2026-11-10T16:20:00-05:00', text: 'error bugfix bugfix:38590: error: worktree create failed' },
    { at: '2026-11-10T16:10:00-05:00', text: 'started review review:38647:2026-11-11: started' },
    { at: '2026-11-10T16:05:00-05:00', text: 'queued review test:review:38626 (priority 99)' }
  ],
  ...over
});

test('describe links PRs, tickets and Slack pings', () => {
  assert.deepEqual(describe('review:38647:2026-11-11'), { label: '#38647', url: 'https://github.com/gobranch/branch/pull/38647' });
  assert.deepEqual(describe('test:review:38626'), { label: '#38626', url: 'https://github.com/gobranch/branch/pull/38626' });
  assert.equal(describe('nt:38500').url, 'https://github.com/gobranch/branch/issues/38500');
  assert.deepEqual(describe('hotfix:1762811400.123456'), { label: 'Slack message', at: 1762811400000 });
  assert.deepEqual(describe('mystery'), { label: 'mystery' });
  assert.deepEqual(describe('bl:35118'), { label: '#35118', url: 'https://github.com/gobranch/branch/issues/35118' });
  assert.equal(describe('prep:27957:2026-11-12').url, 'https://github.com/gobranch/branch/issues/27957');
  assert.equal(describe('review:38647:2026-11-11', { 38647: 'fix(staff-fe): stop the double charge' }).title, 'fix(staff-fe): stop the double charge');
});

test('parseRecent splits verb, kind, key and the start script note', () => {
  const r = parseRecent({ at: '2026-11-10T16:15:09-05:00', text: 'skipped review test:review:38626: skip: merged' });
  assert.deepEqual([r.verb, r.kind, r.key, r.note, r.what.label], ['skipped', 'review', 'test:review:38626', 'skip: merged', '#38626']);
  const q = parseRecent({ at: '2026-11-10T16:13:13-05:00', text: 'queued review test:review:38626 (priority 99)' });
  assert.deepEqual([q.verb, q.key, q.note], ['queued', 'test:review:38626', '']);
  assert.equal(parseRecent({ at: '', text: 'garbled' }).verb, 'other');
});

test('summarize matches VM workspaces by folder name and flags a stuck queue', () => {
  const workspaces = [
    { host: 'vm', path: '/workspaces/branch/.worktrees/branch/review-38647', key: 'vm|abc' },
    { host: 'mac', path: '/Users/x/bugfix-38599', key: 'mac|def' }
  ];
  const s = summarize(status(), workspaces, NOW);
  assert.deepEqual(s.kinds[0].running, [{ name: 'review-38647', key: 'vm|abc' }]);
  assert.deepEqual(s.kinds[1].running, [{ name: 'bugfix-38599', key: null }]);
  assert.equal(s.queue[0].waitedMs, 30 * 60000);
  assert.equal(s.queue[0].what.url, 'https://github.com/gobranch/branch/issues/38601');
  // Fits, waited 30 min, last start 50 min ago, not paused.
  assert.equal(s.stuck, true);
  assert.equal(summarize(status({ paused: 'high load (15.2 on 8 cores)' }), [], NOW).stuck, false);
  assert.equal(summarize(status({ queue: [{ ...status().queue[0], fitsNow: false }] }), [], NOW).stuck, false);
  const fresh = status({ recent: [{ at: '2026-11-10T16:55:00-05:00', text: 'started bugfix bugfix:38599: started' }] });
  assert.equal(summarize(fresh, [], NOW).stuck, false);
  // A start 25 min ago held its slot for 20 min; the next timer tick hasn't run yet.
  const graceJustEnded = status({ recent: [{ at: '2026-11-10T16:35:00-05:00', text: 'started bugfix bugfix:38599: started' }] });
  assert.equal(summarize(graceJustEnded, [], NOW).stuck, false);
  assert.equal(summarize(status({ queue: [] }), [], NOW).stuck, false);
});

test('summarize gives each row its workspace title and note, and a Slack row the workspace title', () => {
  const workspaces = [
    { host: 'vm', path: '/w/review-38647', key: 'vm|abc', name: 'Review #38647 · fix: x', comment: '2 comments posted' },
    { host: 'vm', path: '/w/ease-1762811400123456', key: 'vm|e', name: '#38362 Refund details in billing', comment: 'You: PM sign-off' }
  ];
  const s = summarize(status({
    recent: [
      { at: '2026-11-10T16:10:00-05:00', text: 'started review review:38647:2026-11-11: started', workspace: 'review-38647' },
      { at: '2026-11-10T16:09:00-05:00', text: 'started ease ease:1762811400.123456: started', workspace: 'ease-1762811400123456' },
      { at: '2026-11-10T16:08:00-05:00', text: 'skipped review review:38600:2026-11-11: skip: merged', workspace: 'review-38600' }
    ],
    titles: { 38647: 'fix: x', 38601: 'Bug: refunds stall' }
  }), workspaces, NOW);
  assert.deepEqual(s.recent[0].workspace, { name: 'review-38647', key: 'vm|abc', title: 'Review #38647 · fix: x', comment: '2 comments posted' });
  assert.equal(s.recent[0].what.title, 'fix: x');
  assert.equal(s.recent[1].what.title, '#38362 Refund details in billing');
  // A closed workspace: no key, no note.
  assert.deepEqual(s.recent[2].workspace, { name: 'review-38600', key: null, title: '', comment: '' });
  assert.equal(s.queue[0].what.title, 'Bug: refunds stall');
});

test('summarize titles an ease row from its Ease post and links the Slack thread', () => {
  const posts = [{ ts: '1762811400.123456', title: 'Add the pre-bind ID to the quote PDF', link: 'https://slack/p1', summary: { reason: 'needs a who-sees-it call' } }];
  const s = summarize(status({ queue: [], recent: [{ at: '2026-11-10T16:09:00-05:00', text: 'started ease ease:1762811400.123456: started', workspace: 'ease-1762811400123456' }] }), [], NOW, posts);
  assert.deepEqual([s.recent[0].what.title, s.recent[0].what.url, s.recent[0].outcome], ['Add the pre-bind ID to the quote PDF', 'https://slack/p1', 'needs a who-sees-it call']);
});

test('readSlots runs slots.py status --json on the host and parses it', async () => {
  let script;
  let query;
  const run = async (_cmd, args) => ((query = args[3]), { stdout: JSON.stringify({ data: { repository: { n38601: { title: 'Bug: refunds stall' }, n38590: null, n38647: { title: 'fix: x' } } } }) });
  const data = await readSlots(async (s) => ((script = s), JSON.stringify(status())), run);
  assert.match(script, /slots\.py status --json$/);
  assert.equal(data.budget, 10);
  assert.match(query, /n38601: issueOrPullRequest\(number: 38601\)/);
  assert.deepEqual(data.titles, { 38601: 'Bug: refunds stall', 38647: 'fix: x' });
  // Titles are extra: a GitHub failure still returns the queue.
  const offline = await readSlots(async () => JSON.stringify(status()), async () => { throw new Error('gh: offline'); });
  assert.deepEqual([offline.budget, offline.titles], [10, {}]);
  await assert.rejects(readSlots(async () => 'budget 0/10\n  hotfix 0/2'), /returned text, not JSON: "budget 0\/10"/);
});
