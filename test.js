const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('./lib');

const assistantLine = JSON.stringify({
  type: 'assistant',
  gitBranch: 'poc/33148-staff-reskin',
  message: {
    model: 'claude-fable-5',
    usage: { input_tokens: 2, cache_read_input_tokens: 100000, cache_creation_input_tokens: 500, output_tokens: 45 },
  },
});
const userLine = JSON.stringify({ type: 'user', gitBranch: 'poc/33148-staff-reskin-later' });

test('slugifyCwd matches Claude Code project dir naming', () => {
  assert.equal(lib.slugifyCwd('/Users/x/branch'), '-Users-x-branch');
});

test('parseTranscriptTail: usage from last assistant entry, branch from newest line', () => {
  const tail = '{"partial":true,"cut' + '\n' + assistantLine + '\n' + userLine + '\n';
  const r = lib.parseTranscriptTail(tail);
  assert.equal(r.model, 'claude-fable-5');
  assert.equal(r.usedTokens, 100502);
  assert.equal(r.gitBranch, 'poc/33148-staff-reskin-later');
});

test('parseTranscriptTail: last typed prompt skips tool results and harness noise', () => {
  const typed = JSON.stringify({ type: 'user', message: { content: 'fix the login bug' } });
  const typedArray = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'build panopticlaude' }] } });
  const toolResult = JSON.stringify({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  const command = JSON.stringify({ type: 'user', message: { content: '<command-name>/loop</command-name>' } });
  const sidechain = JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent prompt' } });
  const tail = [typed, typedArray, toolResult, command, sidechain].join('\n') + '\n';
  assert.equal(lib.parseTranscriptTail(tail).lastUserPrompt, 'build panopticlaude');
  assert.equal(lib.parseTranscriptTail(typed + '\n' + toolResult + '\n').lastUserPrompt, 'fix the login bug');
  assert.equal(lib.parseTranscriptTail(command + '\n').lastUserPrompt, null);
});

test('parseTranscriptTail: no assistant entry in tail', () => {
  const r = lib.parseTranscriptTail(userLine + '\n');
  assert.equal(r.usedTokens, null);
  assert.equal(r.gitBranch, 'poc/33148-staff-reskin-later');
});

test('contextWindowSize', () => {
  assert.equal(lib.contextWindowSize('claude-fable-5[1m]'), 1_000_000);
  assert.equal(lib.contextWindowSize('claude-fable-5'), 200_000);
  assert.equal(lib.contextWindowSize(undefined), 200_000);
});

test('pctUsed', () => {
  assert.equal(lib.pctUsed(100_000, 200_000), 50);
  assert.equal(lib.pctUsed(null, 200_000), null);
  assert.equal(lib.pctUsed(300_000, 200_000), 100);
});

test('issueNumberFromBranch', () => {
  assert.equal(lib.issueNumberFromBranch('poc/33148-staff-reskin'), 33148);
  assert.equal(lib.issueNumberFromBranch('trunk'), null);
  assert.equal(lib.issueNumberFromBranch('fix-123'), null);
  assert.equal(lib.issueNumberFromBranch('fix/replay-empty-drivers-4000'), null, 'error codes are not issues');
});

test('repoUrlFromRemote', () => {
  assert.equal(lib.repoUrlFromRemote('git@github.com:gobranch/branch.git\n'), 'https://github.com/gobranch/branch');
  assert.equal(lib.repoUrlFromRemote('https://github.com/cbrandao18/panopticlaude'), 'https://github.com/cbrandao18/panopticlaude');
  assert.equal(lib.repoUrlFromRemote('git@gitlab.com:x/y.git'), null);
});

test('scheduleFromPlist', () => {
  assert.equal(lib.scheduleFromPlist({ StartCalendarInterval: { Hour: 12, Minute: 4 } }), '12:04');
  assert.equal(lib.scheduleFromPlist({ StartCalendarInterval: [{ Hour: 9 }] }), '09:00');
  assert.equal(lib.scheduleFromPlist({}), null);
});

test('lastExitCodeFromLaunchctl', () => {
  assert.equal(lib.lastExitCodeFromLaunchctl('...\n\tlast exit code = 0\n...'), '0');
  assert.equal(lib.lastExitCodeFromLaunchctl('last exit status = 78'), '78');
  assert.equal(lib.lastExitCodeFromLaunchctl('\tlast exit code = (never exited)\n'), 'never-exited');
  assert.equal(lib.lastExitCodeFromLaunchctl('no such line'), null);
});

test('parseTranscriptTail: lastCwd and aiTitle from newest entries', () => {
  const older = JSON.stringify({ type: 'ai-title', aiTitle: 'Old title', sessionId: 's1' });
  const newer = JSON.stringify({ type: 'ai-title', aiTitle: 'Build VSCode Claude code dashboard', sessionId: 's1' });
  const entryWithCwd = JSON.stringify({ type: 'user', toolUseResult: {}, cwd: '/Users/x/branch-worktrees/fix-33201', message: { content: [] } });
  const r = lib.parseTranscriptTail(older + '\n' + newer + '\n' + entryWithCwd + '\n');
  assert.equal(r.aiTitle, 'Build VSCode Claude code dashboard');
  assert.equal(r.lastCwd, '/Users/x/branch-worktrees/fix-33201');
});

test('toolDirHint: file_path dirname and cd targets', () => {
  assert.equal(
    lib.toolDirHint('{"input":{"file_path":"/Users/x/branch-worktrees/fix-33201/staff-fe/src/a.js"}}'),
    '/Users/x/branch-worktrees/fix-33201/staff-fe/src'
  );
  assert.equal(
    lib.toolDirHint('{"input":{"command":"cd /Users/x/branch-worktrees/fix-33201 && yarn test"}}'),
    '/Users/x/branch-worktrees/fix-33201'
  );
  assert.equal(lib.toolDirHint('{"input":{"command":"ls -la"}}'), null);
});

test('workRootFromHints: majority git root wins, non-repo hints dropped', () => {
  const repo = require('path').resolve(__dirname); // this repo has .git
  const hints = [repo + '/scripts', repo, '/tmp/definitely-not-a-repo-xyz', repo + '/hooks'];
  assert.equal(lib.workRootFromHints(hints), repo);
  assert.equal(lib.workRootFromHints(['/tmp/definitely-not-a-repo-xyz']), null);
});

test('parseTranscriptTail: edited files count mutating tools only, question detected', () => {
  const editLine = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/x/read-only.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.js' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/x/b.js' } },
      ],
    },
  });
  const dupEdit = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.js' } }] },
  });
  const question = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Fixed. Want me to also update the docs?' }] },
  });
  const r = lib.parseTranscriptTail(editLine + '\n' + dupEdit + '\n' + question + '\n');
  assert.deepEqual(r.editedFiles.sort(), ['/x/a.js', '/x/b.js']);
  assert.equal(r.lastAssistantText, 'Fixed. Want me to also update the docs?');
});

test('age', () => {
  const now = 1786993000000;
  assert.equal(lib.age(now - 30e3, now), '<1m');
  assert.equal(lib.age(now - 300e3, now), '5m');
  assert.equal(lib.age(now - 7200e3, now), '2h');
  assert.equal(lib.age(null, now), null);
});

test('parseHistoryTail: last prompt per session wins, bad lines skipped', () => {
  const text =
    '{"display":"first prompt","sessionId":"s1"}\n' +
    '{"partial garbage\n' +
    '{"display":"newer prompt","sessionId":"s1"}\n' +
    '{"display":"other chat","sessionId":"s2"}\n';
  const map = lib.parseHistoryTail(text);
  assert.equal(map.get('s1'), 'newer prompt');
  assert.equal(map.get('s2'), 'other chat');
});

test('unseenCount: only new or changed files count', () => {
  const snap = { 'a.md': 100, 'b.md': 200, 'c.md': 300 };
  assert.equal(lib.unseenCount(snap, undefined), 3, 'no snapshot yet: everything counts');
  assert.equal(lib.unseenCount(snap, { 'a.md': 100, 'b.md': 200, 'c.md': 300 }), 0, 'all reviewed');
  assert.equal(lib.unseenCount(snap, { 'a.md': 100, 'b.md': 200 }), 1, 'new file');
  assert.equal(lib.unseenCount(snap, { 'a.md': 100, 'b.md': 999, 'c.md': 300 }), 1, 'modified file');
  assert.equal(lib.unseenCount({}, { 'a.md': 100 }), 0, 'deleted files do not count');
});

test('prLabel: merged age, closed suffix, open bare', () => {
  const now = new Date(2026, 7, 17, 12, 0).getTime();
  const merged = { number: 34079, state: 'MERGED', mergedAt: new Date(2026, 7, 15, 12, 0).toISOString() };
  assert.equal(lib.prLabel(merged, now), 'PR #34079 (merged 2d ago)');
  assert.equal(lib.prLabel({ number: 1, state: 'CLOSED' }, now), 'PR #1 (closed)');
  assert.equal(lib.prLabel({ number: 2, state: 'MERGED' }, now), 'PR #2 (merged)', 'no mergedAt: plain suffix');
  assert.equal(lib.prLabel({ number: 3, state: 'OPEN' }, now), 'PR #3');
  assert.equal(lib.prLabel(null, now), null);
});

test('ciState: failing beats pending beats passing; CheckRun and StatusContext mix', () => {
  assert.equal(lib.ciState(null), null);
  assert.equal(lib.ciState([]), null);
  assert.equal(lib.ciState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(lib.ciState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(lib.ciState([{ conclusion: 'SUCCESS' }, { state: 'PENDING' }, { conclusion: 'FAILURE' }]), 'failing');
  assert.equal(lib.ciState([{ conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }]), 'passing');
});

test('myPrRow: status and description', () => {
  const base = {
    number: 33999,
    title: 'fix the thing',
    url: 'https://github.com/gobranch/branch/pull/33999',
    headRefName: 'fix/33999-thing',
    updatedAt: '2026-08-17T12:00:00Z',
  };
  const approved = lib.myPrRow({
    ...base,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
  });
  assert.equal(approved.status, 'good');
  assert.equal(approved.desc, '#33999 · approved · CI passing · fix/33999-thing');
  const changes = lib.myPrRow({ ...base, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.equal(changes.status, 'bad');
  const ciFail = lib.myPrRow({ ...base, reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.equal(ciFail.status, 'bad');
  const draft = lib.myPrRow({ ...base, isDraft: true, reviewDecision: '', statusCheckRollup: [] });
  assert.equal(draft.status, 'pending');
  assert.equal(draft.desc, '#33999 · draft · fix/33999-thing', 'empty review decision and no checks drop out');
  const approvedNoChecks = lib.myPrRow({ ...base, reviewDecision: 'APPROVED', statusCheckRollup: [] });
  assert.equal(approvedNoChecks.status, 'good', 'no checks counts as passing');
  assert.equal(typeof approved.updatedAt, 'number');
});

test('parseWorktrees: main checkout first, branch stripped, prunable and detached flagged', () => {
  const porcelain = [
    'worktree /Users/x/branch',
    'HEAD aaa',
    'branch refs/heads/trunk',
    '',
    'worktree /Users/x/branch-worktrees/fix-33201',
    'HEAD bbb',
    'branch refs/heads/fix/33201-drafts',
    '',
    'worktree /Users/x/branch-worktrees/old-spike',
    'HEAD ccc',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');
  const wts = lib.parseWorktrees(porcelain);
  assert.equal(wts.length, 3);
  assert.deepEqual(wts[0], { path: '/Users/x/branch', branch: 'trunk', detached: false, prunable: false });
  assert.equal(wts[1].branch, 'fix/33201-drafts');
  assert.equal(wts[2].branch, null);
  assert.equal(wts[2].detached, true);
  assert.equal(wts[2].prunable, true);
  assert.deepEqual(lib.parseWorktrees(''), []);
});

test('nextRun: today if ahead, tomorrow if past', () => {
  const at = (h, m) => new Date(2026, 7, 17, h, m).getTime();
  assert.equal(lib.nextRun('12:04', at(9, 0)), at(12, 4), 'later today');
  assert.equal(lib.nextRun('12:04', at(13, 0)), new Date(2026, 7, 18, 12, 4).getTime(), 'tomorrow');
  assert.equal(lib.nextRun('12:04', at(12, 4)), new Date(2026, 7, 18, 12, 4).getTime(), 'exactly now rolls over');
  assert.equal(lib.nextRun(null, at(9, 0)), null);
});

test('untilTime', () => {
  const now = 1786993000000;
  assert.equal(lib.untilTime(now + 30e3, now), '<1m');
  assert.equal(lib.untilTime(now + 300e3, now), '5m');
  assert.equal(lib.untilTime(now + 19 * 3600e3, now), '19h');
  assert.equal(lib.untilTime(now + 3 * 86400e3, now), '3d');
  assert.equal(lib.untilTime(null, now), null);
});

test('cronOverdue', () => {
  const at = (h, m) => new Date(2026, 7, 17, h, m).getTime();
  assert.equal(lib.cronOverdue('12:04', at(12, 7), at(13, 0)), false, 'ran after schedule');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(13, 0)), true, 'stale log past grace');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(12, 10)), false, 'within grace window');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(11, 0)), false, 'before schedule');
  assert.equal(lib.cronOverdue(null, at(9, 0), at(13, 0)), false, 'no schedule known');
});

// --- assess-assumptions draft files ---

const DRAFT_FIXTURE = [
  '# Assumption-check drafts — 2026-08-19',
  '',
  'Repo verified against: `~/branch`.',
  '',
  '---',
  '',
  '## Draft 1 — #34213 Billing rounding (dabrunetti)',
  '',
  '**Verdict: wrong.**',
  '',
  '```markdown',
  '> 🤖 _Automated assumption check — bot, not a human reviewer._',
  '',
  'body one [full](https://github.com/gobranch/branch/blob/trunk/a.ts#L1) and [rel](packages/billing/src/x.ts#L390).',
  '```',
  '',
  '---',
  '',
  '## Draft 2 — #34211 Community Drive (SimonRoberts16)',
  '',
  '```markdown',
  'body two [anchor](#heading) stays.',
  '```',
].join('\n');

test('parseDraftsFile: extracts draft number, issue, and fenced body', () => {
  const { posted, drafts } = lib.parseDraftsFile(DRAFT_FIXTURE);
  assert.equal(posted, false);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].n, 1);
  assert.equal(drafts[0].issue, 34213);
  assert.match(drafts[0].title, /Billing rounding/);
  assert.match(drafts[0].body, /^> 🤖 _Automated assumption check/);
  assert.match(drafts[0].body, /rel\]\(packages\/billing/);
  assert.ok(!drafts[0].body.includes('```'), 'fence lines stay out of the body');
  assert.equal(drafts[1].issue, 34211);
  assert.match(drafts[1].body, /body two/);
});

test('parseDraftsFile: POSTED banner detected', () => {
  const banner = '> **POSTED 2026-08-19** — drafts 2 posted.\n\n' + DRAFT_FIXTURE;
  assert.equal(lib.parseDraftsFile(banner).posted, true);
});

test('expandRelativeLinks: only repo-relative links get the blob prefix', () => {
  const body = lib.parseDraftsFile(DRAFT_FIXTURE).drafts[0].body;
  const out = lib.expandRelativeLinks(body, 'gobranch/branch');
  assert.match(out, /\[rel\]\(https:\/\/github\.com\/gobranch\/branch\/blob\/trunk\/packages\/billing\/src\/x\.ts#L390\)/);
  assert.equal((out.match(/https:\/\/github\.com\/gobranch\/branch\/blob\/trunk\/a\.ts/g) || []).length, 1, 'absolute link untouched');
  const anchored = lib.expandRelativeLinks('[a](#x) [b](https://y.z)', 'o/r');
  assert.equal(anchored, '[a](#x) [b](https://y.z)');
});

test('draftFileName and latestDraftFile', () => {
  assert.match(lib.draftFileName(new Date(2026, 7, 19).getTime()), /^DRAFTS-2026-08-19\.md$/);
  assert.equal(
    lib.latestDraftFile(['DRAFTS-2026-08-13.md', 'DRAFTS-2026-08-19.md', 'notes.md', '.DS_Store']),
    'DRAFTS-2026-08-19.md'
  );
  assert.equal(lib.latestDraftFile([]), null);
});

test('postedBanner: convention line with comment ids and NOT-posted tail', () => {
  const banner = lib.postedBanner(
    [{ n: 2, issue: 34211, commentUrl: 'https://github.com/gobranch/branch/issues/34211#issuecomment-5346607568' }],
    [{ n: 1, issue: 34213 }],
    new Date(2026, 7, 19).getTime()
  );
  assert.match(banner, /^> \*\*POSTED 2026-08-19\*\* — drafts 2 posted via panopticlaude: #34211 \(issuecomment-5346607568\)\./);
  assert.match(banner, /Drafts 1 \(#34213\) NOT posted — don't post later without asking\. Do not re-post\.$/);
  const noSkips = lib.postedBanner([{ n: 3, issue: 1, commentUrl: 'x#issuecomment-9' }], [], 0);
  assert.ok(!noSkips.includes('NOT posted'));
});

test('usageRows: maps the OAuth /usage limits array to labeled bars', () => {
  const now = Date.parse('2026-08-19T18:00:00Z');
  const json = {
    limits: [
      { kind: 'session', percent: 24, severity: 'normal', resets_at: '2026-08-19T21:00:00Z', scope: null },
      { kind: 'weekly_all', percent: 22, severity: 'normal', resets_at: '2026-08-23T18:00:00Z', scope: null },
      { kind: 'weekly_scoped', percent: 86, severity: 'warning', resets_at: '2026-08-23T18:00:00Z', scope: { model: { display_name: 'Fable' } } },
      { kind: 'mystery', percent: null },
    ],
  };
  const rows = lib.usageRows(json, now);
  assert.deepEqual(rows.map((r) => r.label), ['Session (5hr)', 'Weekly (7 day)', 'Weekly Fable']);
  assert.deepEqual(rows.map((r) => r.pct), [24, 22, 86]);
  assert.equal(rows[0].resets, 'Resets in 3h');
  assert.equal(rows[1].resets, 'Resets in 4d');
  assert.deepEqual(rows.map((r) => r.hot), [false, false, true]);
  assert.deepEqual(lib.usageRows(null), []);
  assert.deepEqual(lib.usageRows({}), []);
});
