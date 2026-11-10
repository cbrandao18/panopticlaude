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
  assert.equal(summarize(status({ queue: [] }), [], NOW).stuck, false);
});

test('readSlots runs slots.py status --json on the host and parses it', async () => {
  let script;
  const data = await readSlots(async (s) => ((script = s), JSON.stringify(status())));
  assert.match(script, /slots\.py status --json$/);
  assert.equal(data.budget, 10);
  await assert.rejects(readSlots(async () => 'budget 0/10\n  hotfix 0/2'), /returned text, not JSON: "budget 0\/10"/);
});
