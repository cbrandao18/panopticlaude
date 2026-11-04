const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, runStatus, ticketStatus, securityData } = require('./security-api');

const SOURCE = `2026-11-04T01:00:00+00:00 started dry-run
2026-11-04T02:00:00+00:00 finished dry-run confirmed 72 filed=0 report=reports/2026-11-03.md
2026-11-04T02:18:28+00:00 gap filed #20 staff-appsync-be/lambdas/x: Query.b
2026-11-09T02:00:00+00:00 started weekly
not a log line
@@BASELINE
{"Query.a": {"verdict": "gap", "issue": 20}, "Query.b": {"verdict": "gap", "issue": 20},
 "Query.c": {"verdict": "gap", "issue": 30}, "Query.d": {"verdict": "ok"}}`;

const t = (number, extra = {}) => ({ number, title: `[Security] Staff API: thing ${number}`, url: `https://github.com/gobranch/branch/issues/${number}`,
  state: 'OPEN', stateReason: null, closedByPullRequestsReferences: { nodes: [] }, ...extra });
const pr = (number, state, isDraft = false) => ({ number, title: `fix ${number}`, url: `https://github.com/gobranch/branch/pull/${number}`, state, isDraft });

test('parses the run log and baseline, ignoring junk lines', () => {
  const { events, baseline } = parse(SOURCE);
  assert.equal(events.length, 4);
  assert.equal(Object.keys(baseline).length, 4);
  const { last, finished } = runStatus(events);
  assert.equal(last.text, 'started weekly');
  assert.match(finished.text, /^finished dry-run/);
  assert.deepEqual(parse('no baseline here').baseline, {});
});

test('ticket status follows the issue and its closing PRs', () => {
  assert.equal(ticketStatus(t(1)), 'todo');
  assert.equal(ticketStatus(t(1, { closedByPullRequestsReferences: { nodes: [pr(5, 'OPEN', true)] } })), 'draft-pr');
  assert.equal(ticketStatus(t(1, { closedByPullRequestsReferences: { nodes: [pr(5, 'CLOSED'), pr(6, 'OPEN')] } })), 'in-review');
  assert.equal(ticketStatus(t(1, { closedByPullRequestsReferences: { nodes: [pr(5, 'MERGED')] } })), 'merged');
  assert.equal(ticketStatus(t(1, { state: 'CLOSED', stateReason: 'COMPLETED' })), 'done');
  assert.equal(ticketStatus(t(1, { state: 'CLOSED', stateReason: 'NOT_PLANNED' })), 'dropped');
  assert.equal(ticketStatus({ number: 2, state: 'OPEN', isDraft: false }), 'in-review');
  assert.equal(ticketStatus({ number: 2, state: 'MERGED', isDraft: false }), 'done');
});

test('groups audit tickets under their parent, keeps the rest as tracked elsewhere', async () => {
  let asked;
  const github = async (numbers) => {
    asked = numbers;
    return {
      parents: [{ ...t(10), subIssues: { nodes: [t(11), t(20, { closedByPullRequestsReferences: { nodes: [pr(21, 'OPEN')] } })] } }],
      standalone: [t(30)]
    };
  };
  const readMap = async () => ({ hosts: [{ workspaces: [{ path: '/w/.worktrees/branch/access-check-gaps', name: '#10 Staff access-check gaps', comment: 'Agent: fixing #11' }] }] });
  const data = await securityData({ source: async () => SOURCE, github, readMap });
  assert.deepEqual(asked.sort(), [20, 30]);
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].parent.title, 'thing 10');
  assert.equal(data.tracked[0].title, 'thing 30');
  assert.deepEqual(data.groups[0].tickets.map((x) => [x.number, x.status, x.fields.length]), [[11, 'todo', 0], [20, 'in-review', 2]]);
  assert.deepEqual(data.tracked.map((x) => [x.number, x.fields]), [[30, ['Query.c']]]);
  assert.equal(data.counts.todo, 2);
  assert.equal(data.counts['in-review'], 1);
  assert.equal(data.fieldCount, 4);
  assert.equal(data.openGaps, 3);
  assert.equal(data.run.last.text, 'started weekly');
  assert.equal(data.workspace.comment, 'Agent: fixing #11');
});
