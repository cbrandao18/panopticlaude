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

test('cronOverdue', () => {
  const at = (h, m) => new Date(2026, 7, 17, h, m).getTime();
  assert.equal(lib.cronOverdue('12:04', at(12, 7), at(13, 0)), false, 'ran after schedule');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(13, 0)), true, 'stale log past grace');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(12, 10)), false, 'within grace window');
  assert.equal(lib.cronOverdue('12:04', at(9, 0), at(11, 0)), false, 'before schedule');
  assert.equal(lib.cronOverdue(null, at(9, 0), at(13, 0)), false, 'no schedule known');
});
