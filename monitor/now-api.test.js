const test = require('node:test');
const assert = require('node:assert/strict');
const { automationRow, statusFromSummary, monitorStatuses, mergeVendors, parseTriageLog, sweepDown, assemble, isFix } = require('./now-api');

const host = { id: 'vm', label: 'VM' };
const now = Date.parse('2026-11-05T22:00:00Z');
const auto = (over = {}) => ({ id: 'a1', name: 'bot', enabled: true, nextRunAt: now + 3600000, rrule: '0 9 * * *', timezone: 'America/New_York', ...over });

test('automationRow: failed, overdue, running, paused, completed', () => {
  assert.equal(automationRow(host, auto(), [{ status: 'failed', createdAt: 1 }], now).status, 'failed');
  assert.equal(automationRow(host, auto(), [{ status: 'dispatch_failed', error: 'blocked', createdAt: 1 }], now).status, 'failed');
  const skipped = automationRow(host, auto(), [{ status: 'skipped_precheck', error: 'Precheck exited with code 1.', createdAt: 1 }], now);
  assert.deepEqual([skipped.status, skipped.error], ['skipped', '']);
  assert.equal(automationRow(host, auto({ nextRunAt: now - 31 * 60000 }), [{ status: 'completed', createdAt: 1 }], now).status, 'overdue');
  assert.equal(automationRow(host, auto({ nextRunAt: now - 10 * 60000 }), [{ status: 'completed', createdAt: 1 }], now).status, 'completed');
  assert.equal(automationRow(host, auto(), [{ status: 'running', createdAt: 2 }, { status: 'failed', createdAt: 1 }], now).status, 'running');
  assert.equal(automationRow(host, auto({ enabled: false }), [{ status: 'failed', createdAt: 1 }], now).status, 'paused');
  assert.equal(automationRow(host, auto(), [], now).status, 'waiting');
});

test('statusFromSummary: ok, incident, degraded component', () => {
  const src = { name: 'Claude', page: 'https://status.claude.com' };
  assert.equal(statusFromSummary(src, { status: { indicator: 'none' }, incidents: [], components: [] }).ok, true);
  const incident = statusFromSummary(src, { status: { indicator: 'minor' }, incidents: [{ name: 'Elevated errors', status: 'investigating', shortlink: 'https://stspg.io/x' }] });
  assert.deepEqual([incident.ok, incident.detail, incident.url], [false, 'Elevated errors', 'https://stspg.io/x']);
  assert.equal(statusFromSummary(src, { status: { indicator: 'none' }, incidents: [{ name: 'Login errors', status: 'investigating', impact: 'none' }] }).ok, true);
  const degraded = statusFromSummary(src, { status: { indicator: 'minor' }, incidents: [], components: [{ name: 'API', status: 'degraded_performance' }] });
  assert.equal(degraded.detail, 'API: degraded performance');
});

test('parseTriageLog reads counts and failures', () => {
  const nights = parseTriageLog('2026-11-04 FAILED slack: timeout\n2026-11-05 6:53pm #38078 fixes=3 design=5 vague=0 fixer=started\nnoise');
  assert.equal(nights.length, 2);
  assert.equal(nights[0].failed, true);
  assert.deepEqual([nights[1].ticket, nights[1].fixes, nights[1].design, nights[1].fixer], [38078, 3, 5, 'started']);
  assert.deepEqual(parseTriageLog('2026-11-06 7:05pm chats=4 bad=1')[0].counts, { chats: 4, bad: 1 });
});

test('sweepDown flags unreadable sources and unticketed prod errors only', () => {
  const down = sweepDown({
    lastRun: { at: '2026-11-05T17:00:00Z', sources: { datadog: 'ok', sentry: 'error: 401' } },
    findings: {
      a: { title: 'Ticketed', ticket: 1, env: 'production' },
      b: { title: 'New one', ticket: null, env: 'production', sources: [{ url: 'u', lastSeen: new Date().toISOString() }] },
      c: { title: 'Dev', ticket: null, env: 'dev' },
      d: { title: 'Borderline', ticket: null, borderline: true, env: 'production', sources: [{ lastSeen: new Date().toISOString() }] },
      e: { title: 'Stale', ticket: null, env: 'production', sources: [{ lastSeen: '2026-01-01T00:00:00Z' }] }
    }
  });
  assert.deepEqual(down.map((d) => d.title), ["Bug sweep couldn't read sentry", 'New one']);
});

test('isFix matches fix and hotfix titles', () => {
  assert.equal(isFix('fix(policy-mod): x'), true);
  assert.equal(isFix('Hotfix: y'), true);
  assert.equal(isFix('feat: z'), false);
});

test('assemble keeps sources independent and builds the tiers', () => {
  const out = assemble({
    automations: { value: [{ name: 'sweep', status: 'failed', host: 'vm', error: 'exit 1' }, { name: 'ok', status: 'completed', host: 'mac' }] },
    statuses: { value: [{ name: 'Claude', ok: false, indicator: 'minor', detail: 'Elevated errors', url: 'u' }, { name: 'GitHub', ok: true }] },
    reviews: { error: 'gh: not logged in' },
    map: { value: { hosts: [{ label: 'VM', workspaces: [{ key: 'k', host: 'vm', name: 'W', comment: 'You: approve #1', lastActivityAt: 5 }, { key: 'j', comment: 'Agent: busy' }, { key: 'e', name: 'Ease · P', comment: 'You: decide' }] }] } },
    ease: { value: { posts: [{ title: 'P', whose: 'you', workspace: { name: 'Ease · P', comment: 'clear 123: raw note' }, actions: [{ text: 'done', state: 'done' }, { text: 'decide', state: 'open', url: 'u' }] }, { title: 'Q', whose: 'agent' }] } },
    merge: { value: { ready: [{ number: 2, title: 'feat: a' }, { number: 3, title: 'fix: b' }], waiting: [] } },
    releases: { value: [] },
    findings: { value: null },
    jobs: { value: [{ name: 'assess', hasInbox: true, unread: 2 }] }
  });
  assert.deepEqual(out.down.map((d) => d.kind), ['vendor', 'automation']);
  assert.deepEqual(out.ready.map((p) => p.number), [3, 2]);
  assert.deepEqual(out.blocked.agents.map((a) => a.ask), ['approve #1']);
  assert.deepEqual(out.blocked.ease.map((e) => e.next), ['decide']);
  assert.deepEqual(out.blocked.drafts, [{ name: 'assess', unread: 2 }]);
  assert.deepEqual(out.errors, [{ source: 'reviews', error: 'gh: not logged in' }]);
});

test('statusFromSummary: component filter ignores the rest of a shared page', () => {
  const src = { name: 'SendGrid', page: 'p', components: /^SendGrid (Mail Sending|API)$/ };
  const summary = {
    status: { indicator: 'minor' },
    components: [{ id: 1, name: 'SendGrid API', status: 'operational' }, { id: 2, name: 'SMS, Europe', status: 'degraded_performance' }],
    incidents: [{ name: 'SMS delays', status: 'investigating', components: [{ id: 2 }] }]
  };
  assert.equal(statusFromSummary(src, summary).ok, true);
  summary.components[0].status = 'major_outage';
  assert.deepEqual([statusFromSummary(src, summary).ok, statusFromSummary(src, summary).detail], [false, 'SendGrid API: major outage']);
});

test('statusFromSummary: Stripe and Better Uptime formats', () => {
  assert.equal(statusFromSummary({ name: 'Stripe', kind: 'stripe' }, { largestatus: 'up', statuses: { api: 'up' } }).ok, true);
  assert.equal(statusFromSummary({ name: 'Stripe', kind: 'stripe' }, { largestatus: 'degraded', statuses: { api: 'degraded' } }).detail, 'api: degraded');
  assert.equal(statusFromSummary({ name: 'BT', kind: 'betteruptime' }, { data: { attributes: { aggregate_state: 'operational' } } }).ok, true);
  assert.equal(statusFromSummary({ name: 'BT', kind: 'betteruptime' }, { data: { attributes: { aggregate_state: 'downtime' } } }).ok, false);
});

test('monitorStatuses: Alert/Warn fire, missing monitors are flagged', () => {
  const rows = monitorStatuses([{ id: 335332041, name: 'ClarionDoor stopped', overall_state: 'Alert' }, { id: 284942402, name: 'TU', overall_state: 'No Data' }]);
  const cd = rows.find((r) => r.name === 'ClarionDoor');
  assert.deepEqual([cd.ok, cd.detail], [false, 'ClarionDoor stopped']);
  assert.equal(rows.find((r) => r.name === 'TransUnion').ok, true);
  assert.equal(rows.find((r) => r.name === 'Stripe').indicator, 'unreadable');
});

test('mergeVendors combines a status page and monitors under one name', () => {
  const merged = mergeVendors([{ name: 'Stripe', ok: true, detail: '' }, { name: 'Stripe', ok: false, indicator: 'alert', detail: 'ACH fallback', url: 'dd' }, { name: 'Lob', ok: true }]);
  assert.deepEqual(merged.map((v) => [v.name, v.ok, v.url || null]), [['Stripe', false, 'dd'], ['Lob', true, null]]);
});
