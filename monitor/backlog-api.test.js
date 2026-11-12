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
