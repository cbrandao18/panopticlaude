// Security tickets from the weekly access-check audit: each parent ticket with its sub-issues (fields
// covered, fix PRs, state), plus the audit's last run. Read-only. Source of truth is the audit folder on
// the VM (runs.log, baseline.json), joined with GitHub.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const SCRIPT = [
  'cd ~/branch-agents/projects/process-updates/access-audit || exit 1',
  'cat runs.log 2>/dev/null',
  "echo '@@BASELINE'",
  'cat baseline.json 2>/dev/null',
  'true'
].join('\n');

// The Mac keeps its own runs.log (gitignored), so only /workspaces/branch marks the VM.
function runOnHost(script, run = exec) {
  const [cmd, args] = fs.existsSync('/workspaces/branch') ? ['/bin/sh', ['-c', script]] : ['coder', ['ssh', 'branch-ec2.main', '--', script]];
  return run(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);
}
const readSource = () => runOnHost(SCRIPT);

function parse(text) {
  const [logPart, basePart = ''] = `\n${text}`.split('\n@@BASELINE\n');
  const events = [];
  for (const line of logPart.split('\n')) {
    const m = /^(\S+) (.+)$/.exec(line.trim());
    if (m && Number.isFinite(Date.parse(m[1]))) events.push({ time: Date.parse(m[1]), text: m[2] });
  }
  let baseline = {};
  try {
    baseline = basePart.trim() ? JSON.parse(basePart) : {};
  } catch {
    baseline = {};
  }
  return { events, baseline };
}

// The newest started/finished/failed line, and the newest finished one.
function runStatus(events) {
  const runs = events.filter((e) => /^(started|finished|failed)\b/.test(e.text));
  const last = runs.at(-1) || null;
  const finished = runs.filter((e) => e.text.startsWith('finished')).at(-1) || null;
  return { last, finished };
}

function fieldsByIssue(baseline) {
  const out = {};
  for (const [field, entry] of Object.entries(baseline)) {
    if (entry?.issue) (out[entry.issue] ||= []).push(field);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

const TICKET = 'number title url state stateReason closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number title url state isDraft } }';
// Some audit tickets are [appsec] PRs, not issues, so look numbers up as either.
const EITHER = (inner) => `issueOrPullRequest(number: %N) { ... on Issue { ${inner} } ... on PullRequest { number title url state isDraft } }`;

async function graphql(query, run = exec) {
  const { stdout } = await run('/opt/homebrew/bin/gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const body = JSON.parse(stdout);
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data.repository;
}

// Two queries: which parent each audit ticket hangs under, then each parent with its sub-issues and
// the audit tickets that have no parent.
async function readGithub(numbers, run = exec) {
  if (!numbers.length) return { parents: [], standalone: [] };
  const repo = (inner) => `{ repository(owner: "gobranch", name: "branch") { ${inner} } }`;
  const first = await graphql(repo(numbers.map((n) => `i${n}: ${EITHER('number parent { number }').replace('%N', n)}`).join(' ')), run);
  const parentNumbers = [...new Set(Object.values(first).map((i) => i?.parent?.number).filter(Boolean))];
  const loose = Object.values(first).filter((i) => i && !i.parent).map((i) => i.number);
  const second = await graphql(repo([
    ...parentNumbers.map((n) => `p${n}: issue(number: ${n}) { ${TICKET} subIssues(first: 50) { nodes { ${TICKET} } } }`),
    ...loose.map((n) => `s${n}: ${EITHER(TICKET).replace('%N', n)}`)
  ].join(' ')), run);
  return {
    parents: parentNumbers.map((n) => second[`p${n}`]).filter(Boolean),
    standalone: loose.map((n) => second[`s${n}`]).filter(Boolean)
  };
}

function ticketStatus(t) {
  if (t.isDraft !== undefined) return { OPEN: t.isDraft ? 'draft-pr' : 'in-review', MERGED: 'done', CLOSED: 'dropped' }[t.state];
  if (t.state === 'CLOSED') return t.stateReason === 'NOT_PLANNED' ? 'dropped' : 'done';
  const prs = t.closedByPullRequestsReferences?.nodes || [];
  const open = prs.find((p) => p.state === 'OPEN');
  if (open) return open.isDraft ? 'draft-pr' : 'in-review';
  return prs.some((p) => p.state === 'MERGED') ? 'merged' : 'todo';
}

function ticket(t, fields) {
  return {
    number: t.number,
    title: t.title.replace(/^\W*\[Security\]\s*(Staff API:|HIGH:|MEDIUM:|LOW:)?\s*/, ''),
    url: t.url,
    kind: t.isDraft === undefined ? 'issue' : 'pr',
    status: ticketStatus(t),
    fields: fields[t.number] || [],
    prs: (t.closedByPullRequestsReferences?.nodes || []).map(({ number, title, url, state, isDraft }) => ({ number, title, url, state, isDraft }))
  };
}

async function securityData({ source = readSource, github = readGithub, readMap } = {}) {
  const { events, baseline } = parse(await source());
  const fields = fieldsByIssue(baseline);
  const { parents, standalone } = await github(Object.keys(fields).map(Number));
  const groups = parents.map((p) => ({ parent: ticket(p, fields), tickets: p.subIssues.nodes.map((t) => ticket(t, fields)) }));
  const tracked = standalone.map((t) => ticket(t, fields));
  const counts = { todo: 0, 'draft-pr': 0, 'in-review': 0, merged: 0, done: 0, dropped: 0 };
  for (const t of [...groups.flatMap((g) => g.tickets), ...tracked]) counts[t.status]++;
  const map = readMap ? await readMap().catch(() => null) : null;
  const ws = (map?.hosts || []).flatMap((h) => h.workspaces).find((w) => w.path?.endsWith('/access-check-gaps'));
  const entries = Object.values(baseline);
  return {
    refreshedAt: Date.now(),
    run: runStatus(events),
    fieldCount: entries.length,
    openGaps: entries.filter((e) => e.verdict === 'gap').length,
    groups,
    tracked,
    counts,
    workspace: ws ? { name: ws.name, comment: ws.comment || '' } : null
  };
}

function createSecurityReader(options = {}, ttl = 120000) {
  let cached = null;
  let pending = null;
  const read = () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= securityData(options)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read the access-check audit: ${String(e.message).slice(0, 200)}`, groups: [], tracked: [] }))
      .finally(() => { pending = null; });
    return pending;
  };
  read.clear = () => { cached = null; };
  return read;
}

module.exports = { parse, runStatus, fieldsByIssue, ticketStatus, securityData, createSecurityReader, runOnHost };
