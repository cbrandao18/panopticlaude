const test = require('node:test');
const assert = require('node:assert/strict');
const { automationRow, statusFromSummary, monitorStatuses, mergeVendors, parseTriageLog, readRelease, sweepDown, stalled, assemble, isFix } = require('./now-api');

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

test('readRelease turns a workspace file history into daily counts and progress', async () => {
  const commands = [];
  const host = async (cmd) => (commands.push(cmd), '2026-11-05 totalFiles=3123 muiImport=1041\n2026-11-10 totalFiles=3199 muiImport=450\n');
  const r = await readRelease({ name: 'x', workspace: '/w/x', file: 'a/b.json', progress: ['muiImport', 'files off MUI'] }, { host });
  assert.match(commands[0], /cd '\/w\/x'.*git log --reverse/s);
  assert.deepEqual([r.nights.length, r.last.counts.muiImport], [2, 450]);
  assert.deepEqual(r.progress, { label: 'files off MUI', total: 1041, completed: 591 });
});

test('sweepDown flags unreadable sources and unticketed prod errors only', () => {
  const down = sweepDown({
    lastRun: { at: '2026-11-05T17:00:00Z', sources: { datadog: 'ok', sentry: 'failed: 401', logrocket: 'partial: 8 of ~20 sessions' } },
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

test('assemble puts a stuck slot queue on Down and reports an unreachable VM', () => {
  const base = { automations: { value: [] }, statuses: { value: [] }, reviews: { value: [] }, map: { value: { hosts: [] } }, ease: { value: {} },
    merge: { value: { ready: [], waiting: [] } }, releases: { value: [] }, findings: { value: null }, jobs: { value: [] } };
  const now = Date.parse('2026-11-10T17:00:00-05:00');
  const slots = { value: { at: '2026-11-10T16:59:00-05:00', budget: 10, used: 0, paused: null, kinds: {}, recent: [],
    queue: [{ position: 1, kind: 'review', key: 'review:1:2026-11-10', priority: 50, queuedAt: '2026-11-10T16:30:00-05:00', fitsNow: true }] } };
  const out = assemble({ ...base, slots, now });
  assert.equal(out.slots.stuck, true);
  assert.match(out.down.find((d) => /slot queue/.test(d.title)).detail, /1 queued item fits now/);
  const down = assemble({ ...base, slots: { error: 'coder: connection refused' }, now });
  assert.deepEqual([down.slots, down.slotsError], [null, 'coder: connection refused']);
  assert.ok(down.errors.some((e) => e.source === 'slots'));
});

test('isFix matches fix and hotfix titles', () => {
  assert.equal(isFix('fix(policy-mod): x'), true);
  assert.equal(isFix('Hotfix: y'), true);
  assert.equal(isFix('feat: z'), false);
});

test('attention separates waiting, blockers, failed runs and FYIs without losing review backlog', () => {
  const now = Date.now();
  const ws = (key, comment) => ({ key, name: key, host: 'vm', comment, agents: [], lastActivityAt: now - 3600000 });
  const out = assemble({
    automations: { value: [{ key: 'failed-auto', name: 'Example automation', status: 'failed' }, { key: 'late', status: 'overdue' }] },
    statuses: { value: [] }, reviews: { value: [{ url: 'https://example.com/review', title: 'Review requested' }] },
    map: { value: { hosts: [{ workspaces: [ws('request', 'You: approve the change'), ws('blocker', 'You: Blocked: access expired'),
      ws('info', 'You: FYI: preview ready'), ws('done', 'Agent: finished the report'), ws('stalled', 'Agent: fixing'),
      ws('failure', 'Failed: build exited 1')], runs: [{ key: 'run', objective: 'Example run', tasks: [
        { title: 'Failed task', status: 'failed', workspace: 'failure' }, { title: 'Successful task', status: 'completed' }
      ] }] }] } },
    ease: { value: { posts: [] } }, merge: { value: { ready: [], waiting: [] } }, releases: { value: [] },
    findings: { value: null }, jobs: { value: [{ name: 'drafts', hasInbox: true, unread: 4 }] }, now
  });
  assert.deepEqual(out.attention.waiting.agents.map(a => a.key), ['request']);
  assert.equal(out.attention.waiting.reviews.length, 1);
  assert.equal(out.attention.waiting.drafts[0].unread, 4);
  assert.deepEqual(out.attention.blocked.map(a => a.key), ['blocker']);
  assert.deepEqual(out.attention.stalled.map(a => a.key), ['stalled']);
  assert.deepEqual(out.attention.fyi.map(a => a.key), ['info', 'done']);
  assert.deepEqual(out.attention.failed.map(a => a.key), ['failure', 'failed-auto']);
  assert.ok(out.attention.failed[0].ask.includes('build exited 1'));
});

test('closed workspaces show under FYI for 3 days, newest first, linking the ticket or post', () => {
  const { parseClosed } = require('./now-api');
  const now = Date.parse('2026-11-11T21:00:00Z');
  const closed = parseClosed([
    '2026-11-11T16:20:33-0500 closed ease-1 https://team-branch.slack.com/archives/C1/p1 | Ease · Example post | skipped: already planned',
    '2026-11-11T12:00:00-0500 closed nt-2 https://github.com/gobranch/branch/issues/2 | #2 Example ticket | not an easy win: needs a product call',
    '2026-11-01T12:00:00-0500 closed nt-3 https://github.com/gobranch/branch/issues/3 | #3 Old | skipped',
    'garbage line'
  ].join('\n'), 'vm');
  assert.equal(closed.length, 3);
  const base = { automations: { value: [] }, statuses: { value: [] }, reviews: { value: [] }, map: { value: { hosts: [] } },
    ease: { value: { posts: [] } }, merge: { value: { ready: [], waiting: [] } }, releases: { value: [] }, findings: { value: null }, jobs: { value: [] } };
  const fyi = assemble({ ...base, closed: { value: closed }, now }).attention.fyi;
  assert.deepEqual(fyi.map(a => a.name), ['Ease · Example post', '#2 Example ticket']);
  assert.deepEqual(fyi.map(a => a.linkText), ['View post', 'View ticket']);
  assert.equal(fyi[1].ask, 'Workspace closed, not an easy win: needs a product call');
  assert.equal(fyi[1].url, 'https://github.com/gobranch/branch/issues/2');
  assert.equal(fyi[1].workspaceKey, null);
  assert.deepEqual(assemble({ ...base, closed: { error: 'coder: connection refused' }, now }).errors.map(e => e.source), ['closed']);
});

test('Ease actions follow their current workspace status without disappearing when the map is unavailable', () => {
  const base = {
    automations: { value: [] }, statuses: { value: [] }, reviews: { value: [] },
    ease: { value: { posts: [{ title: 'Example Ease request', whose: 'you', workspace: { name: 'Ease example' },
      actions: [{ state: 'open', text: 'Review example' }] }] } },
    merge: { value: { ready: [], waiting: [] } }, releases: { value: [] }, findings: { value: null }, jobs: { value: [] }
  };
  for (const [marker, state] of [['Blocked', 'blocked'], ['Failed', 'failed'], ['FYI', 'fyi']]) {
    const out = assemble({ ...base, map: { value: { hosts: [{ workspaces: [{ key: 'ease', name: 'Ease example', comment: `You: ${marker}: Example reason` }] }] } } });
    assert.equal(out.attention.waiting.ease.length, 0, marker);
    assert.equal(out.attention[state].length, 1, marker);
    assert.equal(out.blocked.ease.length, 1, 'Older open browser tabs retain their data');
  }
  assert.equal(assemble({ ...base, map: { error: 'unreachable' } }).attention.waiting.ease.length, 1);
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

test('stalled: Agent: comment with nothing running, unless the parent runs or an automation owns it', () => {
  const now = 10 * 3600000;
  const old = now - 3600000;
  const ws = (key, extra) => ({ key, name: key, comment: 'Agent: fixing', lastActivityAt: old, live: 0, agents: [], ...extra });
  const rows = [
    ws('idle'),
    ws('done', { agents: [{ state: 'done' }] }),
    ws('working', { agents: [{ state: 'working' }] }),
    ws('script', { live: 1 }),
    ws('fresh', { lastActivityAt: now - 60000 }),
    ws('you', { comment: 'You: approve #1' }),
    ws('auto', { status: 'status-8' }),
    ws('vm|sched'),
    ws('parent', { agents: [{ state: 'working' }] }),
    ws('queued', { parent: 'parent' }),
    ws('orphan', { parent: 'idle' })
  ];
  const autos = [{ host: 'vm', workspace: 'sched', enabled: true }, { host: 'vm', workspace: 'idle', enabled: false }];
  assert.deepEqual(stalled(rows, now, autos).map((w) => w.key), ['idle', 'done', 'auto', 'orphan']);
  const out = assemble({
    automations: { value: [] }, statuses: { value: [] }, reviews: { value: [] }, ease: { value: { posts: [] } },
    merge: { value: { ready: [], waiting: [] } }, releases: { value: [] }, findings: { value: null }, jobs: { value: [] },
    map: { value: { hosts: [{ workspaces: [ws('idle')] }] } }, now
  });
  assert.deepEqual(out.blocked.agents.map((a) => a.ask), ['Restart or update: no agent behind "Agent: fixing"']);
});

test('medic: row status from its heartbeat, and its last actions newest first', () => {
  const { medicActions, medicRow } = require('./now-api');
  const log = [
    '2026-11-06 11:44:30PM VM reachable again',
    '2026-11-07 9:03:48AM Starting responder for:',
    'Stalled workspaces:',
    '- Roost (mac, worktree id x): Restart or update',
    'responder: Roost: comment fixed',
    'responder: 2026-11-07 9:31AM #37812: resumed'
  ].join('\n');
  const acts = medicActions(log);
  assert.deepEqual(acts.map((a) => a.text), ['#37812: resumed', 'Roost: comment fixed', 'VM reachable again']);
  assert.equal(acts[0].at, new Date(2026, 10, 7, 9, 3, 48).getTime());
  assert.equal(acts[2].at, new Date(2026, 10, 6, 23, 44, 30).getTime());
  const now = Date.now();
  assert.equal(medicRow({ lastRun: now - 60000, responderRunning: false, log: '' }, now).status, 'completed');
  assert.equal(medicRow({ lastRun: now - 60000, responderRunning: true, log: '' }, now).status, 'running');
  assert.equal(medicRow({ lastRun: now - 20 * 60000, responderRunning: false, log: '' }, now).status, 'overdue');
  assert.equal(medicRow({ lastRun: null, responderRunning: false, log: '' }, now).status, 'waiting');
});
