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

// Runs locally when this host has the log (the VM), otherwise over Coder SSH from the Mac.
function runOnHost(script, run = exec) {
  const local = fs.existsSync(path.join(os.homedir(), 'orca/projects/daily-brief/ease.log'));
  const [cmd, args] = local ? ['/bin/sh', ['-c', script]] : ['coder', ['ssh', 'branch-ec2.main', '--', script]];
  return run(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);
}
const readSource = () => runOnHost(SCRIPT);

function parse(text) {
  const [logPart, rest = ''] = `\n${text}`.split('\n@@TODO\n');
  const events = [];
  for (const line of logPart.split('\n')) {
    const m = /^(\S+) ([a-z-]+) (\d+\.\d+): (.*)$/.exec(line.trim());
    if (m && Number.isFinite(Date.parse(m[1]))) events.push({ time: Date.parse(m[1]), kind: m[2], ts: m[3], text: m[4] });
  }
  // With no todo.md lines the first marker has no newline before it.
  const [todoPart, ...draftParts] = `\n${rest}`.split('\n@@DRAFT ');
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

function buildPost(ts, events, { todo, drafts }, ws, ghStates) {
  const id = ts.replace('.', '');
  const outcomeEvent = [...events].reverse().find((e) => !['started', 'drafted'].includes(e.kind)) || events.at(-1);
  const prEvents = events.filter((e) => ['pr', 'clear', 'blocked'].includes(e.kind));
  const last = prEvents.at(-1);
  const prUrl = last && /https:\/\/github\.com\/gobranch\/branch\/pull\/\d+/.exec(last.text)?.[0];
  const pr = prUrl ? ghStates[prNumber(prUrl)] : null;
  const todoLine = todo.find((l) => l.includes(id));
  const draft = drafts[id] || null;
  const actions = [];

  if (prUrl) {
    if (pr?.state === 'MERGED') actions.push({ text: 'PR merged', state: 'done', url: prUrl });
    else if (pr?.state === 'CLOSED') actions.push({ text: 'PR closed without merging', state: 'done', url: prUrl });
    else if (pr?.staff === false) actions.push({ text: 'PR is outside Staff: hand it to the owning team', state: 'done', url: prUrl });
    else if (pr && !pr.isDraft) actions.push({ text: 'PR marked ready: waiting on review and merge', state: 'done', url: prUrl });
    else if (last.kind === 'blocked') actions.push({ text: `Unblock the PR: ${last.text.replace(prUrl, '').trim()}`, state: 'open', url: prUrl });
    else if (last.kind === 'clear') actions.push({ text: 'Dev deploy and live check, then mark the PR ready', state: 'open', url: prUrl });
    else actions.push({ text: 'Agent is running the Devlo review and CI', state: 'waiting', url: prUrl });
  }
  // A filed line reads "#<n> <issue url>"; show it as "Filed <issue title>".
  const filedLink = (e) => {
    const url = /https:\/\/github\.com\/gobranch\/branch\/issues\/(\d+)/.exec(e.text);
    return url && { url: url[0], title: ghStates[Number(url[1])]?.title || `#${url[1]}` };
  };
  const filed = events.findLast((e) => e.kind === 'filed' && filedLink(e));
  if (filed) {
    const { url, title } = filedLink(filed);
    actions.push({ text: `Filed ${title}`, state: 'done', url });
  } else if (events.some((e) => e.kind === 'not-easy')) {
    actions.push(todoLine
      ? { text: 'Decide on the ticket draft (file it, or drop it from todo.md)', state: 'open', ...(ticketFromDraft(draft) ? { ticket: ticketFromDraft(draft) } : { draft }) }
      : { text: 'Ticket draft decided (removed from todo.md)', state: 'done' });
  }
  if (events.some((e) => e.kind === 'drafted')) {
    actions.push({ text: 'Send your saved Slack reply in the thread', state: 'unknown', url: slackLink(ts) });
  }

  // One-line summary: the verdict from the log, the reason without the todo/ file path, and the draft's requester line.
  const verdictEvent = events.findLast((e) => e.kind === 'not-easy');
  const verdict = events.some((e) => e.kind === 'pr') ? 'easy' : verdictEvent ? 'not-easy' : null;
  const skipEvent = events.findLast((e) => e.kind === 'skipped');
  const reasonText = (verdict === 'not-easy' ? verdictEvent : verdict ? null : skipEvent)?.text;
  const summary = {
    requester: /^- Requester: (.+)$/m.exec(draft || '')?.[1].trim() || null,
    verdict: verdict || (skipEvent ? 'skipped' : null),
    reason: reasonText ? reasonText.replace(/\s*\(todo\/ease-\d+\.md\)\s*$/, '').trim() : null,
    replyDraft: events.some((e) => e.kind === 'drafted') ? 'saved' : null
  };
  const name = ws?.name && !/^Ease · \d+\.\d+$/.test(ws.name) ? ws.name.replace(/^Ease · /, '') : null;
  const heading = draft && /^# (.+)$/m.exec(draft)?.[1];
  const priority = /ease-and-effort \((High|Medium|Low)\)/.exec(todoLine || '')?.[1] || /\*\*(High|Medium|Low)\*\*/.exec(draft || '')?.[1] || null;
  const comment = ws?.comment || '';
  // Your job stops at the ticket; only an unfiled draft or a Staff PR is yours. The workspace's "You:" comment doesn't count.
  const open = actions.some((a) => a.state === 'open');
  const working = !open && (outcomeEvent.kind === 'started' || actions.some((a) => a.state === 'waiting'));
  return {
    ts,
    link: slackLink(ts),
    title: name || heading || pr?.title || `Suggestion posted ${new Date(Number(ts) * 1000).toISOString().slice(0, 10)}`,
    priority,
    summary,
    issue: Number(/\/issues\/(\d+)/.exec(filed ? filedLink(filed).url : '')?.[1]) || null,
    pr: prNumber(prUrl),
    outcome: outcomeEvent.kind,
    whose: open ? 'you' : working ? 'agent' : 'closed',
    updatedAt: events.at(-1).time,
    workspace: ws ? { name: ws.name, comment } : null,
    events: events.map(({ time, kind, text }) => (kind === 'filed' && filedLink({ text }) ? { time, kind, text: '', link: filedLink({ text }) } : { time, kind, text })),
    actions
  };
}

// The draft's "## Paste-ready ticket draft" section: an optional "Title:" line (bold or plain, else the
// draft's # heading), then the template's ### fields, possibly wrapped in a code fence.
function ticketFromDraft(draft) {
  const m = /^## Paste-ready ticket draft.*$/m.exec(draft || '');
  if (!m) return null;
  const section = draft.slice(m.index + m[0].length).split(/^## /m)[0];
  const first = section.search(/^### /m);
  if (first < 0) return null;
  const title = (/^(?:\*\*Title:\*\*|Title:)\s*(.+)$/m.exec(section.slice(0, first)) || /^# (.+)$/m.exec(draft))?.[1].trim();
  const body = section.slice(first).replace(/\n```\s*$/, '').trim();
  return title ? { title, body } : null;
}

// Files the drafted ticket as the gh user, unless the post is already on GitHub, then logs it and
// drops the todo.md line on the VM so the brief and this page both show it decided.
async function fileTicket(ts, { source = readSource, host = runOnHost, run = exec } = {}) {
  if (!/^\d+\.\d+$/.test(ts)) throw Object.assign(new Error('Unknown post.'), { status: 400 });
  const id = ts.replace('.', '');
  const parsed = parse(await source());
  if (parsed.events.some((e) => e.ts === ts && e.kind === 'filed')) throw Object.assign(new Error('Already filed.'), { status: 409 });
  const ticket = ticketFromDraft(parsed.drafts[id]);
  if (!ticket) throw Object.assign(new Error('No ticket draft found for this post.'), { status: 404 });
  const gh = (args) => run('/opt/homebrew/bin/gh', args, { timeout: 30000 }).then((r) => r.stdout);
  const existing = JSON.parse(await gh(['search', 'issues', '--repo', 'gobranch/branch', '--include-prs', `p${id}`, '--json', 'url']));
  if (existing.length) throw Object.assign(new Error(`Already on GitHub: ${existing.map((e) => e.url).join(' ')}`), { status: 409 });
  const issue = JSON.parse(await gh(['api', 'repos/gobranch/branch/issues', '-f', `title=${ticket.title}`, '-f', `body=${ticket.body}`, '-f', 'type=Story']));
  const url = issue.html_url;
  if (!/^https:\/\/github\.com\/gobranch\/branch\/issues\/\d+$/.test(url)) return { url, number: issue.number, warning: 'Filed, but the VM log and todo.md were not updated.' };
  try {
    await host([
      'cd ~/orca/projects/daily-brief || exit 1',
      `printf '%s filed ${ts}: #${issue.number} ${url}\\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" >> ease.log`,
      `grep -v 'todo/ease-${id}\\.md' todo.md > todo.md.tmp; mv todo.md.tmp todo.md`
    ].join('\n'));
  } catch {
    return { url, number: issue.number, warning: 'Filed, but the VM log and todo.md were not updated.' };
  }
  return { url, number: issue.number };
}

// A PR is Staff when it changes staff-* packages and no other app package; shared files (packages/, lockfile, docs) don't count.
const OTHER_APP = /^(?!staff-)[^/]+-(fe|be)\/|^(accountmobile|ember-mobile)\//;
const isStaffPr = (files) => files.some((f) => f.startsWith('staff-')) && !files.some((f) => OTHER_APP.test(f));

// The issues endpoint answers for both PRs and issues.
async function readGithubStates(numbers, run = exec) {
  const entries = await Promise.all(numbers.map(async (n) => {
    try {
      const { stdout } = await run('/opt/homebrew/bin/gh', ['api', `repos/gobranch/branch/issues/${n}`, '-q',
        '{state: (if .pull_request.merged_at then "MERGED" else (.state | ascii_upcase) end), isDraft: (.draft // false), title, isPull: (.pull_request != null)}'], { timeout: 15000 });
      const info = JSON.parse(stdout);
      if (info.isPull) {
        const files = await run('/opt/homebrew/bin/gh', ['api', `repos/gobranch/branch/pulls/${n}/files`, '--paginate', '-q', '.[].filename'], { timeout: 30000 });
        info.staff = isStaffPr(files.stdout.split('\n').filter(Boolean));
      }
      return [n, info];
    } catch {
      return [n, null];
    }
  }));
  return Object.fromEntries(entries);
}

async function easeData({ source = readSource, readMap, ghStates = readGithubStates } = {}) {
  const parsed = parse(await source());
  const byTs = new Map();
  for (const e of parsed.events) byTs.set(e.ts, [...(byTs.get(e.ts) || []), e]);
  const map = readMap ? await readMap().catch(() => null) : null;
  const workspaces = (map?.hosts || []).flatMap((h) => h.workspaces);
  const numbers = parsed.events.filter((e) => ['pr', 'clear', 'blocked', 'filed'].includes(e.kind))
    .map((e) => Number(/github\.com\/gobranch\/branch\/(?:pull|issues)\/(\d+)/.exec(e.text)?.[1])).filter(Boolean);
  const states = await ghStates([...new Set(numbers)]);
  const posts = [...byTs].map(([ts, events]) =>
    buildPost(ts, events, parsed, workspaces.find((w) => w.path?.endsWith(`/ease-${ts.replace('.', '')}`)), states));
  const order = { you: 0, agent: 1, closed: 2 };
  posts.sort((a, b) => order[a.whose] - order[b.whose] || b.updatedAt - a.updatedAt);
  return { refreshedAt: Date.now(), mapError: map ? null : 'Workspace names unavailable.', posts };
}

function createEaseReader(options = {}, ttl = 60000) {
  let cached = null;
  let pending = null;
  const read = () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= easeData(options)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read the ease-and-effort log: ${String(e.message).slice(0, 200)}`, posts: [] }))
      .finally(() => { pending = null; });
    return pending;
  };
  read.clear = () => { cached = null; };
  return read;
}

module.exports = { isStaffPr, readGithubStates, parse, buildPost, easeData, createEaseReader, ticketFromDraft, fileTicket };
