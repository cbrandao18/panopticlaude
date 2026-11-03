// #ease-and-effort posts as one tree each: what the agent did, then what's left for Christie.
// Source of truth is the daily-brief folder on the host that runs ease-effort-watch (the VM).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const CHANNEL = 'C02MK5V05CJ';
const SCRIPT = [
  'cd ~/orca/projects/daily-brief || exit 1',
  'cat ease.log 2>/dev/null',
  "echo '@@TODO'",
  "grep -h 'ease-and-effort' todo.md 2>/dev/null",
  'for f in todo/ease-*.md; do [ -f "$f" ] && echo "@@DRAFT $f" && cat "$f"; done',
  'true'
].join('\n');

const slackLink = (ts) => `https://team-branch.slack.com/archives/${CHANNEL}/p${ts.replace('.', '')}`;

// Reads locally when this host has the log (the VM), otherwise over Coder SSH from the Mac.
function readSource(run = exec) {
  const local = fs.existsSync(path.join(os.homedir(), 'orca/projects/daily-brief/ease.log'));
  const [cmd, args] = local ? ['/bin/sh', ['-c', SCRIPT]] : ['coder', ['ssh', 'branch-ec2.main', '--', SCRIPT]];
  return run(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);
}

function parse(text) {
  const [logPart, rest = ''] = `\n${text}`.split('\n@@TODO\n');
  const events = [];
  for (const line of logPart.split('\n')) {
    const m = /^(\S+) ([a-z-]+) (\d+\.\d+): (.*)$/.exec(line.trim());
    if (m && Number.isFinite(Date.parse(m[1]))) events.push({ time: Date.parse(m[1]), kind: m[2], ts: m[3], text: m[4] });
  }
  const [todoPart, ...draftParts] = rest.split('\n@@DRAFT ');
  const drafts = {};
  for (const part of draftParts) {
    const newline = part.indexOf('\n');
    const id = /ease-(\d+)\.md$/.exec(part.slice(0, newline))?.[1];
    if (id) drafts[id] = part.slice(newline + 1).trim();
  }
  const todo = todoPart.split('\n').filter((l) => l.startsWith('- '));
  return { events, todo, drafts };
}

const prNumber = (url) => Number(/\/pull\/(\d+)/.exec(url || '')?.[1]) || null;

function buildPost(ts, events, { todo, drafts }, ws, prStates) {
  const id = ts.replace('.', '');
  const outcomeEvent = [...events].reverse().find((e) => !['started', 'drafted'].includes(e.kind)) || events.at(-1);
  const prEvents = events.filter((e) => ['pr', 'clear', 'blocked'].includes(e.kind));
  const last = prEvents.at(-1);
  const prUrl = last && /https:\/\/github\.com\/gobranch\/branch\/pull\/\d+/.exec(last.text)?.[0];
  const pr = prUrl ? prStates[prNumber(prUrl)] : null;
  const todoLine = todo.find((l) => l.includes(id));
  const draft = drafts[id] || null;
  const actions = [];

  if (prUrl) {
    if (pr?.state === 'MERGED') actions.push({ text: 'PR merged', state: 'done', url: prUrl });
    else if (pr?.state === 'CLOSED') actions.push({ text: 'PR closed without merging', state: 'done', url: prUrl });
    else if (pr && !pr.isDraft) actions.push({ text: 'PR marked ready: waiting on review and merge', state: 'done', url: prUrl });
    else if (last.kind === 'blocked') actions.push({ text: `Unblock the PR: ${last.text.replace(prUrl, '').trim()}`, state: 'open', url: prUrl });
    else if (last.kind === 'clear') actions.push({ text: 'Dev deploy and live check, then mark the PR ready', state: 'open', url: prUrl });
    else actions.push({ text: 'Agent is running the Devlo review and CI', state: 'waiting', url: prUrl });
  }
  if (events.some((e) => e.kind === 'not-easy')) {
    actions.push(todoLine
      ? { text: 'Decide on the ticket draft (file it, or drop it from todo.md)', state: 'open', draft }
      : { text: 'Ticket draft decided (removed from todo.md)', state: 'done' });
  }
  if (events.some((e) => e.kind === 'drafted')) {
    actions.push({ text: 'Send your saved Slack reply in the thread', state: 'unknown', url: slackLink(ts) });
  }

  const name = ws?.name && !/^Ease · \d+\.\d+$/.test(ws.name) ? ws.name.replace(/^Ease · /, '') : null;
  const heading = draft && /^# (.+)$/m.exec(draft)?.[1];
  const priority = /ease-and-effort \((High|Medium|Low)\)/.exec(todoLine || '')?.[1] || /\*\*(High|Medium|Low)\*\*/.exec(draft || '')?.[1] || null;
  const comment = ws?.comment || '';
  const open = actions.some((a) => a.state === 'open') || /^You:/.test(comment);
  const working = !open && (outcomeEvent.kind === 'started' || actions.some((a) => a.state === 'waiting'));
  return {
    ts,
    link: slackLink(ts),
    title: name || heading || pr?.title || `Suggestion posted ${new Date(Number(ts) * 1000).toISOString().slice(0, 10)}`,
    priority,
    outcome: outcomeEvent.kind,
    whose: open ? 'you' : working ? 'agent' : 'closed',
    updatedAt: events.at(-1).time,
    workspace: ws ? { name: ws.name, comment } : null,
    events: events.map(({ time, kind, text }) => ({ time, kind, text })),
    actions
  };
}

async function readPrStates(numbers, run = exec) {
  const entries = await Promise.all(numbers.map(async (n) => {
    try {
      const { stdout } = await run('/opt/homebrew/bin/gh', ['pr', 'view', String(n), '--repo', 'gobranch/branch', '--json', 'state,isDraft,title'], { timeout: 15000 });
      return [n, JSON.parse(stdout)];
    } catch {
      return [n, null];
    }
  }));
  return Object.fromEntries(entries);
}

async function easeData({ source = readSource, readMap, prStates = readPrStates } = {}) {
  const parsed = parse(await source());
  const byTs = new Map();
  for (const e of parsed.events) byTs.set(e.ts, [...(byTs.get(e.ts) || []), e]);
  const map = readMap ? await readMap().catch(() => null) : null;
  const workspaces = (map?.hosts || []).flatMap((h) => h.workspaces);
  const prs = [...new Set(parsed.events.filter((e) => ['pr', 'clear', 'blocked'].includes(e.kind)).map((e) => prNumber(e.text)).filter(Boolean))];
  const states = await prStates(prs);
  const posts = [...byTs].map(([ts, events]) =>
    buildPost(ts, events, parsed, workspaces.find((w) => w.path?.endsWith(`/ease-${ts.replace('.', '')}`)), states));
  const order = { you: 0, agent: 1, closed: 2 };
  posts.sort((a, b) => order[a.whose] - order[b.whose] || b.updatedAt - a.updatedAt);
  return { refreshedAt: Date.now(), mapError: map ? null : 'Workspace names unavailable.', posts };
}

function createEaseReader(options = {}, ttl = 60000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= easeData(options)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read the ease-and-effort log: ${String(e.message).slice(0, 200)}`, posts: [] }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { parse, buildPost, easeData, createEaseReader };
