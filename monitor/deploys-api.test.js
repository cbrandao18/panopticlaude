const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deploysData, checkHeartbeat, escapeAppleScript } = require('./deploys-api');

const MIN = 60000;
const NOW = Date.parse('2026-11-06T15:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploys-api-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}
const envFile = (extra = {}) => ({ env: 'christie', branch: 'christie', staff_url: 'https://christie.example.dev/staff', entries: [], ...extra });
const heartbeat = (msAgo) => ({ 'envs/state/heartbeat.json': { last_gate: iso(msAgo) } });

test('deploysData marks stale after 45 minutes', async () => {
  const fresh = await deploysData({ root: fixture({ 'envs/christie.json': envFile(), ...heartbeat(44 * MIN) }), now: NOW });
  const old = await deploysData({ root: fixture({ 'envs/christie.json': envFile(), ...heartbeat(46 * MIN) }), now: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.equal(old.lastGate, iso(46 * MIN));
});

test('deploysData lists flags and entry statuses', async () => {
  const root = fixture({
    'envs/christie.json': envFile({ entries: [{ pr: 12 }, { pr: 13 }, { branch: 'cb/thing' }] }),
    'envs/state/christie.json': {
      pinned_date: '2026-11-06', branch_head: 'abcdef1234567890', last_run: iso(5 * MIN), lock_holder: 'session-7',
      entries: {
        'pr:12': { head: 'a1', status: 'deployed', since: iso(MIN), note: '' },
        'pr:13': { head: 'b2', status: 'skipped: conflict', since: iso(MIN), note: 'conflicts with #12' },
        'branch:cb/thing': { head: 'c3', status: 'merged', since: iso(MIN), note: '' }
      },
      flags: { 'stale:pr:12': { message: 'PR 12 is behind trunk.', since: iso(MIN) } }
    },
    ...heartbeat(MIN)
  });
  const data = await deploysData({ root, now: NOW });
  const [env] = data.envs;
  assert.equal(env.env, 'christie');
  assert.equal(env.head, 'abcdef1');
  assert.equal(env.pinnedTrunk, '2026-11-06');
  assert.equal(env.lock, 'session-7');
  assert.equal(env.staffUrl, 'https://christie.example.dev/staff');
  assert.deepEqual(env.entries.map((e) => [e.key, e.status, e.url]), [
    ['pr:12', 'deployed', 'https://github.com/gobranch/branch/pull/12'],
    ['pr:13', 'skipped: conflict', 'https://github.com/gobranch/branch/pull/13'],
    ['branch:cb/thing', 'merged', null]
  ]);
  assert.equal(env.entries[2].label, 'cb/thing');
  assert.deepEqual(env.flags.map((f) => f.message), ['PR 12 is behind trunk.']);
});

test('deploysData treats an absent lock as null', async () => {
  const root = fixture({ 'envs/christie.json': envFile(), 'envs/state/christie.json': { entries: {} }, ...heartbeat(MIN) });
  assert.equal((await deploysData({ root, now: NOW })).envs[0].lock, null);
});

test('missing state files return an error object, not a throw', async () => {
  const noState = await deploysData({ root: fixture({ 'envs/christie.json': envFile() }), now: NOW });
  assert.equal(noState.stale, true);
  assert.equal(noState.lastGate, null);
  assert.equal(noState.envs[0].env, 'christie');
  assert.match(noState.envs[0].error, /state/i);
  assert.deepEqual(noState.log, []);
  const noRoot = await deploysData({ root: path.join(os.tmpdir(), 'deploys-api-does-not-exist'), now: NOW });
  assert.match(noRoot.error, /couldn.t read/i);
  assert.deepEqual(noRoot.envs, []);
});

test('deploysData discovers environments from envs/*.json', async () => {
  const root = fixture({ 'envs/zed.json': envFile({ env: 'zed' }), 'envs/amy.json': envFile({ env: 'amy' }), 'envs/notes.txt': 'x', 'envs/state/amy.json': {} });
  assert.deepEqual((await deploysData({ root, now: NOW })).envs.map((e) => e.env), ['amy', 'zed']);
});

test('deploysData returns only the last 50 log lines', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${iso((60 - i) * MIN)} christie event ${i + 1}`);
  const root = fixture({ 'envs/christie.json': envFile(), 'envs/state/deploys.log': `${lines.join('\n')}\n` });
  const { log } = await deploysData({ root, now: NOW });
  assert.equal(log.length, 50);
  assert.equal(log[0].text, 'event 11');
  assert.deepEqual(log.at(-1), { time: Date.parse(iso(MIN)), env: 'christie', text: 'event 60' });
});

function heartbeatFixture(msAgo) {
  const root = fixture(msAgo == null ? {} : heartbeat(msAgo));
  const statePath = path.join(root, 'notified.json');
  const sent = [];
  return { root, statePath, sent, notify: async (text) => { sent.push(text); } };
}
const gateAt = (root, msAgo) => fs.writeFileSync(path.join(root, 'envs/state/heartbeat.json'), JSON.stringify({ last_gate: iso(msAgo) }));

test('stale notification fires once per episode', async () => {
  const h = heartbeatFixture(60 * MIN);
  await checkHeartbeat({ ...h, now: NOW });
  await checkHeartbeat({ ...h, now: NOW + 5 * MIN });
  await checkHeartbeat({ ...h, now: NOW + 10 * MIN });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /deployer/i);
});

test('stale notification resets after a fresh heartbeat', async () => {
  const h = heartbeatFixture(60 * MIN);
  await checkHeartbeat({ ...h, now: NOW });
  gateAt(h.root, MIN);
  await checkHeartbeat({ ...h, now: NOW });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.statePath, 'utf8')), { notifiedFor: null });
  gateAt(h.root, 50 * MIN);
  await checkHeartbeat({ ...h, now: NOW });
  assert.equal(h.sent.length, 2);
});

test('a heartbeat file that never existed shows as stale but sends nothing', async () => {
  const h = heartbeatFixture(null);
  const result = await checkHeartbeat({ ...h, now: NOW });
  assert.equal(result.stale, true);
  assert.equal(h.sent.length, 0);
  assert.equal(fs.existsSync(h.statePath), false);
});

test('AppleScript text escapes backslashes before quotes', () => {
  assert.equal(escapeAppleScript('a "b" \\c'), 'a \\"b\\" \\\\c');
});
