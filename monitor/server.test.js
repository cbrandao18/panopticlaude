const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMonitor, jobStatus, inboxFiles } = require('./server');

async function fixture(t, options = {}, withFindings = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panopticlaude-monitor-'));
  const inbox = path.join(dir, 'drafts');
  fs.mkdirSync(inbox);
  const name = 'DRAFTS-2026-09-24.md';
  fs.writeFileSync(path.join(inbox, name), '## Draft 1 — #123 Example\n\n```markdown\nAn exact comment.\n```\n');
  fs.writeFileSync(path.join(dir, 'runs.log'), 'Completed a fixture run.\n');
  fs.writeFileSync(path.join(dir, 'cron.out'), 'Fixture agent output.');
  fs.writeFileSync(path.join(dir, 'launchd.err'), '');
  const job = { label: 'com.example.fixture', log: path.join(dir, 'runs.log'), inbox, repo: 'owner/repo' };
  const shots = path.join(dir, 'bot', 'shots');
  if (withFindings) {
    fs.mkdirSync(shots, { recursive: true });
    job.findings = path.join(dir, 'bot', 'findings.json');
  }
  const seen = {};
  const run = async (command) => ({
    stdout:
      command === 'plutil'
        ? '{"StartCalendarInterval":{"Hour":12,"Minute":4}}'
        : 'state = not running\nlast exit code = 0'
  });
  const server = createMonitor({
    jobs: [job],
    run,
    renderMarkdown: async (text) => `<p>${text}</p>`,
    readSeen: () => seen,
    writeSeen: (label, snapshot) => {
      seen[label] = snapshot;
    },
    ...options
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route, params = {}, options = {}) =>
    fetch(`${base}/api/${route}?${new URLSearchParams({ job: job.label, ...params })}`, options);
  const review = (files, headers = {}) =>
    get(
      'review',
      {},
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1', ...headers },
        body: JSON.stringify({ files })
      }
    );
  return { job, get, review, name, inbox, run, seen, base, dir, shots };
}

test('posting uses the server draft, rejects stale previews, and protects writes', async (t) => {
  const posted = [];
  const f = await fixture(t, {
    postDraft: async (job, draft) => {
      posted.push({ job, draft });
      return { status: 'posted', commentUrl: 'https://github.com/owner/repo/issues/123#issuecomment-456' };
    }
  });
  const data = await (await f.get('file', { name: f.name })).json();
  const post = (changes = {}, headers = {}) =>
    f.get(
      'post',
      {},
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1', ...headers },
        body: JSON.stringify({ name: f.name, version: data.version, n: 1, ...changes })
      }
    );
  assert.equal((await post({}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({}, { 'X-Panopticlaude': '' })).status, 403);
  assert.equal((await post({ name: '../runs.log' })).status, 404);
  assert.equal((await post({ n: 2 })).status, 400);
  assert.equal((await post({ body: 'Attacker replacement', repo: 'evil/repo' })).status, 200);
  assert.equal(posted[0].draft.body, 'An exact comment.\n');
  assert.equal(posted[0].job.repo, 'owner/repo');
  fs.appendFileSync(path.join(f.inbox, f.name), '\nChanged');
  assert.equal((await post()).status, 409);
  assert.equal(posted.length, 1);
  fs.writeFileSync(path.join(f.inbox, f.name), `> **POSTED yesterday**\n${data.text}`);
  const latest = await (await f.get('file', { name: f.name })).json();
  assert.equal((await post({ version: latest.version })).status, 409);
});

test('monitor reads launchd, logs, and exact draft bodies over HTTP', async (t) => {
  const f = await fixture(t);
  const status = await (await f.get('status')).json();
  assert.equal(status.jobs[0].exit, '0');
  assert.equal(status.jobs[0].unread, 1);
  assert.equal((await (await f.get('log')).json()).text, 'Completed a fixture run.\n');
  const draft = await (await f.get('file', { name: f.name })).json();
  assert.equal(draft.drafts[0].body, 'An exact comment.\n');
  assert.equal(draft.drafts[0].issue, 123);
});

test('review only marks the version shown; new files remain unread', async (t) => {
  const f = await fixture(t);
  const {
    jobs: [job]
  } = await (await f.get('status')).json();
  fs.writeFileSync(path.join(f.inbox, 'new.md'), 'new file');
  assert.equal((await f.review(job.files)).status, 200);
  assert.equal((await (await f.get('status')).json()).jobs[0].unread, 1);
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(f.inbox, f.name), later, later);
  assert.equal((await f.review(job.files)).status, 409);
  assert.equal((await (await f.get('status')).json()).jobs[0].unread, 2);
});

test('file reads reject traversal and symlinks outside the inbox', async (t) => {
  const f = await fixture(t);
  fs.symlinkSync(f.job.log, path.join(f.inbox, 'linked.md'));
  assert.equal((await f.get('file', { name: '../runs.log' })).status, 404);
  assert.equal((await f.get('file', { name: 'linked.md' })).status, 404);
  assert.equal((await f.get('log', { kind: '../runs.log' })).status, 404);
});

test('cross-origin reads and writes, forged hosts, and simple POSTs are rejected', async (t) => {
  const f = await fixture(t);
  const {
    jobs: [job]
  } = await (await f.get('status')).json();
  assert.equal((await f.review(job.files, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await f.review(job.files, { 'X-Panopticlaude': '' })).status, 403);
  assert.equal((await f.get('status', {}, { headers: { Origin: 'https://example.com' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    http
      .get(`${f.base}/api/status`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.deepEqual(f.seen, {});
});

test('running status takes precedence over an earlier exit; missing launchd is unknown', async (t) => {
  const f = await fixture(t);
  const running = await jobStatus(f.job, {
    run: async (command) =>
      command === 'plutil' ? f.run(command) : { stdout: 'state = running\npid = 42\nlast exit code = 1' },
    readSeen: () => ({})
  });
  assert.equal(running.status, 'running');
  const unknown = await jobStatus(f.job, {
    run: async () => {
      throw new Error('unloaded');
    },
    readSeen: () => ({})
  });
  assert.equal(unknown.status, 'unknown');
  assert.ok(unknown.warnings.length);
});

test('Orca status reads the saved schedule and latest run, without consulting launchd', async (t) => {
  const f = await fixture(t);
  f.job.automationId = 'automation-fixture';
  let enabled = true;
  let rrule = 'FREQ=DAILY;BYHOUR=12;BYMINUTE=34';
  const runs = [
    { createdAt: 100, status: 'failed', error: 'Old failure' },
    { createdAt: 200, startedAt: 205, status: 'completed' }
  ];
  const run = async (command, args) => {
    assert.match(command, /orca$/);
    assert.equal(args[0], 'automations');
    const result =
      args[1] === 'show'
        ? {
            automation: {
              enabled,
              rrule,
              timezone: 'America/New_York',
              nextRunAt: 500
            }
          }
        : { runs };
    return { stdout: JSON.stringify({ ok: true, result }) };
  };
  const read = () => jobStatus(f.job, { run, readSeen: () => ({}) });
  const result = await read();
  assert.equal(result.source, 'orca');
  assert.equal(result.status, 'completed');
  assert.equal(result.schedule, 'Daily at 12:34 · America/New_York');
  assert.equal(result.nextRunAt, 500);
  assert.equal(result.lastRunAt, 205);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.unread, 1);
  enabled = false;
  assert.equal((await read()).status, 'paused');
  assert.equal((await read()).nextRunAt, null);
  runs[1].status = 'dispatched';
  assert.equal((await read()).status, 'running');
  enabled = true;
  for (const status of ['failed', 'skipped', 'cancelled']) {
    runs[1].status = status;
    assert.equal((await read()).status, status);
  }
  runs.length = 0;
  assert.equal((await read()).status, 'waiting');
  rrule = 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0';
  assert.equal((await read()).schedule, 'Mondays at 10:00 · America/New_York');
});

test('Orca outages and RPC errors stay unknown rather than looking successful', async (t) => {
  const f = await fixture(t);
  f.job.automationId = 'automation-fixture';
  for (const run of [
    async () => {
      throw new Error('Offline');
    },
    async () => ({ stdout: JSON.stringify({ ok: false, error: { message: 'Unavailable' } }) })
  ]) {
    const status = await jobStatus(f.job, { run, readSeen: () => ({}) });
    assert.equal(status.status, 'unknown');
    assert.equal(status.nextRunAt, null);
    assert.match(status.warnings.join(' '), /Orca status/);
    assert.equal(status.latestDraft, f.name);
  }
});

test('Orca log tabs return the latest saved output and errors, not stale cron files', async (t) => {
  const runs = [
    {
      createdAt: 200,
      title: 'Fixture run 2',
      error: 'Fixture authentication failure',
      outputSnapshot: { content: 'Latest Orca output', truncated: true }
    },
    { createdAt: 100, outputSnapshot: { content: 'Old Orca output' } }
  ];
  const f = await fixture(t, { run: async () => ({ stdout: JSON.stringify({ ok: true, result: { runs } }) }) });
  f.job.automationId = 'automation-fixture';
  const output = await (await f.get('log', { kind: 'output' })).json();
  assert.equal(output.text, 'Latest Orca output');
  assert.equal(output.name, 'Fixture run 2');
  assert.equal(output.truncated, true);
  const errors = await (await f.get('log', { kind: 'errors' })).json();
  assert.equal(errors.text, 'Fixture authentication failure');
  assert.equal(errors.truncated, false);
  assert.equal((await (await f.get('log')).json()).text, 'Completed a fixture run.\n');
  runs.length = 0;
  assert.match((await (await f.get('log', { kind: 'output' })).json()).text, /No saved output/);
});

test('drafts include GitHub-rendered HTML and fall back to raw text when rendering fails', async (t) => {
  const calls = [];
  const rendered = await fixture(t, {
    renderMarkdown: async (text, repo) => {
      calls.push({ text, repo });
      return '<p>An exact comment.</p>';
    }
  });
  const data = await (await rendered.get('file', { name: rendered.name })).json();
  assert.equal(data.drafts[0].html, '<p>An exact comment.</p>');
  assert.deepEqual(calls, [{ text: data.drafts[0].body, repo: 'owner/repo' }]);

  const failing = await fixture(t, {
    renderMarkdown: async () => {
      throw new Error('gh unavailable');
    }
  });
  const fallback = await (await failing.get('file', { name: failing.name })).json();
  assert.equal(fallback.drafts[0].html, null);
  assert.equal(fallback.drafts[0].body, 'An exact comment.\n');
});

test('skip feedback validates reasons, saves per draft, and comes back with the file', async (t) => {
  const f = await fixture(t);
  const data = await (await f.get('file', { name: f.name })).json();
  assert.ok(data.skipReasons['no-scope-change']);
  assert.equal(data.drafts[0].skipped, null);
  const skip = (changes = {}, headers = {}) =>
    f.get(
      'skip',
      {},
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1', ...headers },
        body: JSON.stringify({ name: f.name, version: data.version, n: 1, reasons: ['no-scope-change'], note: '', ...changes })
      }
    );
  assert.equal((await skip({}, { 'X-Panopticlaude': '' })).status, 403);
  assert.equal((await skip({ reasons: ['made-up'] })).status, 400);
  assert.equal((await skip({ reasons: [], note: '  ' })).status, 400);
  assert.equal((await skip({ n: 2 })).status, 400);
  assert.equal((await skip({ version: 'stale' })).status, 409);
  assert.equal((await skip({ reasons: ['already-known', 'already-known'], note: ' PM decided in Slack ' })).status, 200);
  const saved = (await (await f.get('file', { name: f.name })).json()).drafts[0].skipped;
  assert.deepEqual(saved.reasons, ['already-known']);
  assert.equal(saved.note, 'PM decided in Slack');
  assert.equal(saved.issue, 123);
  assert.equal(saved.file, f.name);
  assert.equal(fs.readdirSync(path.join(f.inbox, '.monitor-feedback')).length, 1);
});

test('inbox files sort newest first by the date in the name, across prefixes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panopticlaude-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['DRAFTS-2026-08-17.md', 'AUTO-POSTED-2026-10-12.md', 'notes.md', 'AUTO-POSTED-2026-10-14.md']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  assert.deepEqual(
    inboxFiles(dir).map((file) => file.name),
    ['AUTO-POSTED-2026-10-14.md', 'AUTO-POSTED-2026-10-12.md', 'DRAFTS-2026-08-17.md', 'notes.md']
  );
});

const finding = (key, lastSeen) => ({
  key,
  title: key,
  sources: [{ type: 'sentry', url: 'https://example.com', count: 2, countLabel: 'users', firstSeen: lastSeen, lastSeen }]
});

test('findings route returns sorted findings and lastRun, empty when missing', async (t) => {
  const f = await fixture(t, {}, true);
  assert.equal((await fixture(t).then((plain) => plain.get('findings'))).status, 404);
  assert.deepEqual(await (await f.get('findings')).json(), { lastRun: null, findings: [] });
  const lastRun = { at: '2026-10-22T16:04:00Z', mode: 'file', sources: { datadog: 'ok', sentry: 'failed: 403' } };
  fs.writeFileSync(
    f.job.findings,
    JSON.stringify({
      version: 1,
      lastRun,
      findings: { old: finding('old', '2026-10-20T00:00:00Z'), new: finding('new', '2026-10-22T00:00:00Z') }
    })
  );
  const body = await (await f.get('findings')).json();
  assert.deepEqual(
    body.findings.map((item) => item.key),
    ['new', 'old']
  );
  assert.equal(body.lastRun.sources.sentry, 'failed: 403');
  assert.equal((await (await f.get('status')).json()).jobs[0].hasFindings, true);
  fs.rmSync(f.job.findings);
  assert.deepEqual(await (await f.get('findings')).json(), { lastRun: null, findings: [] });
});

test('findings route reports invalid JSON as a readable 500', async (t) => {
  const f = await fixture(t, {}, true);
  fs.writeFileSync(f.job.findings, '{"version":1,"findings":{');
  const response = await f.get('findings');
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /^findings\.json can't be read: /);
});

test('fix log kind serves fix.log next to the run log', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, 'fix.log'), 'Fixer opened a PR.\n');
  const body = await (await f.get('log', { kind: 'fix' })).json();
  assert.equal(body.name, 'fix.log');
  assert.equal(body.text, 'Fixer opened a PR.\n');
});

test('shot route serves PNGs from shots/ and rejects traversal, symlinks and other names', async (t) => {
  const f = await fixture(t, {}, true);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(path.join(f.shots, 'a.png'), png);
  fs.writeFileSync(path.join(f.shots, 'a.txt'), 'text');
  fs.writeFileSync(f.job.findings, '{}');
  fs.symlinkSync(f.job.findings, path.join(f.shots, 'b.png'));
  const ok = await f.get('shot', { name: 'a.png' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
  for (const name of ['../findings.json', 'a.txt', 'b.png', 'missing.png']) {
    const response = await f.get('shot', { name });
    assert.equal(response.status, 404, name);
    assert.deepEqual(await response.json(), { error: 'Screenshot not found.' });
  }
  assert.equal((await (await fixture(t)).get('shot', { name: 'a.png' })).status, 404);
});

test('Now, Map and Work pages are served with the vendored helpers; /api/now returns the reader', async (t) => {
  const f = await fixture(t, { readNow: async () => ({ down: [], marker: 'now' }) });
  for (const [route, text] of [['/', '/now.js'], ['/map', '/map.js'], ['/work', 'id="viewer"'], ['/vendor/preact.js', 'export'], ['/vendor/hooks.js', './preact.js']]) {
    const res = await fetch(`${f.base}${route}`);
    assert.equal(res.status, 200, route);
    assert.match(await res.text(), new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), route);
  }
  assert.deepEqual(await (await f.get('now')).json(), { down: [], marker: 'now' });
});

test('/api/intake/reviewed needs the monitor header and accepts only intake run keys', async (t) => {
  const seen = [];
  const f = await fixture(t, { markIntakeReviewed: (key) => seen.push(key) });
  const post = (key, headers = { 'X-Panopticlaude': '1' }) => fetch(`${f.base}/api/intake/reviewed`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ key }) });
  const key = 'https://github.com/gobranch/branch/actions/runs/123#38872';
  assert.equal((await post(key, {})).status, 403);
  assert.equal((await post('../../etc#1')).status, 400);
  assert.equal((await post(key)).status, 200);
  assert.deepEqual(seen, [key]);
});

test('/api/orca/open needs the monitor header and passes only the key', async (t) => {
  const seen = [];
  const f = await fixture(t, { readMap: async () => ({ hosts: [] }), openInOrca: async (key) => (seen.push(key), { opened: true }) });
  const post = (headers) => fetch(`${f.base}/api/orca/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ key: 'vm|x' }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'X-Panopticlaude': '1' })).status, 200);
  assert.deepEqual(seen, ['vm|x']);
});
