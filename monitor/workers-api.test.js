const test = require('node:test');
const assert = require('node:assert/strict');
const { launchdRow, parseVm } = require('./workers-api');

const print = (fields) => `gui/501/x = {\n${Object.entries(fields).map(([k, v]) => `\t${k} = ${v}`).join('\n')}\n\tendpoints = {\n\t\tstate = active\n\t}\n}`;

test('launchdRow: interval job, always-on job, failures and conflicts', () => {
  const ok = launchdRow('agent-sync', print({ state: 'not running', 'run interval': '900 seconds', 'last exit code': '0' }));
  assert.deepEqual([ok.status, ok.schedule, ok.host, ok.kind], ['completed', 'every 15 min', 'mac', 'LaunchAgent']);
  assert.equal(launchdRow('pilot', print({ state: 'not running', 'run interval': '21600 seconds', 'last exit code': '(never exited)' })).schedule, 'every 6 h');
  assert.equal(launchdRow('job', print({ state: 'running', 'run interval': '300 seconds', 'last exit code': '0' })).status, 'running');
  const tunnel = launchdRow('tunnel', print({ state: 'running', 'last exit code': '0' }));
  assert.deepEqual([tunnel.status, tunnel.schedule], ['running', 'always on']);
  const stopped = launchdRow('tunnel', print({ state: 'not running', 'last exit code': '1' }));
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.error, /should always run/);
  assert.match(launchdRow('feed', print({ state: 'not running', 'run interval': '900 seconds', 'last exit code': '2' })).error, /exited with code 2/);
  assert.match(launchdRow('gone', null).error, /not loaded/);
  const cal = launchdRow('cleanup', `${print({ state: 'not running', 'last exit code': '0' })}\n\t\t"com.apple.launchd.calendarinterval" = {\n\t\t}`, '', { Hour: 3, Minute: 0 });
  assert.deepEqual([cal.status, cal.schedule], ['completed', 'daily at 3:00am']);
  assert.match(launchdRow('agent-sync', print({ state: 'not running', 'run interval': '900 seconds', 'last exit code': '0' }), 'CONFLICT in memory/x.md').error, /conflict: CONFLICT/);
});

test('parseVm: timers joined to their service results', () => {
  const now = 1794066000000;
  const timers = [
    { next: (now + 600000) * 1000, last: (now - 300000) * 1000, unit: 'review-watch.timer', activates: 'review-watch.service' },
    { next: (now + 600000) * 1000, last: (now - 300000) * 1000, unit: 'agent-sync.timer', activates: 'agent-sync.service' },
    { next: (now - 3600000) * 1000, last: (now - 7200000) * 1000, unit: 'close-finished-runs.timer', activates: 'close-finished-runs.service' },
    { next: (now + 600000) * 1000, last: null, unit: 'staff-feedback-release.timer', activates: 'staff-feedback-release.service' },
    { next: (now + 600000) * 1000, last: null, unit: 'launchpadlib-cache-clean.timer', activates: 'launchpadlib-cache-clean.service' }
  ];
  const show = [
    'Result=exit-code\nExecMainStatus=1\nId=review-watch.service\nActiveState=failed',
    'Result=success\nExecMainStatus=0\nId=agent-sync.service\nActiveState=inactive',
    'Result=success\nExecMainStatus=0\nId=close-finished-runs.service\nActiveState=inactive',
    'Result=success\nExecMainStatus=0\nId=staff-feedback-release.service\nActiveState=activating'
  ].join('\n\n');
  const rows = parseVm(`${JSON.stringify(timers)}\n@@SHOW\n${show}\n@@CONFLICT\nCONFLICT x\n`, now);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [
    ['review-watch', 'failed'], ['agent-sync', 'failed'], ['close-finished-runs', 'overdue'], ['staff-feedback-release', 'running']
  ]);
  assert.match(rows[0].error, /exit-code, exit 1/);
  assert.match(rows[1].error, /conflict: CONFLICT x/);
  assert.equal(rows[0].lastRunAt, now - 300000);
  assert.equal(rows[0].key, 'vm|worker:review-watch');
});
