// The VM's agent slot queue (process-updates slots/slots.py): what runs per kind, what starts next, what just
// started or got skipped. One `slots.py status --json` call over the same host runner as the other VM cards.
const STUCK_MS = 15 * 60000;
// slots.py START_GRACE: a fresh start holds its slot this long, so a slot can free up only 20 min after the last start.
const GRACE_MS = 20 * 60000;
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const SCRIPT = '. ~/orca/projects/daily-brief/env.sh && /usr/bin/python3 ~/branch-agents/projects/process-updates/slots/slots.py status --json';
const REPO = 'https://github.com/gobranch/branch';

const numberOf = (key) => /(?:^|:)(?:review|bugfix|nt):(\d+)/.exec(key)?.[1];

// PR and ticket titles for the queued and recent rows, in one GitHub query. Titles are extra: a failure leaves them out.
async function readTitles(keys, run) {
  const numbers = [...new Set(keys.map(numberOf).filter(Boolean))];
  if (!numbers.length) return {};
  const query = `{ repository(owner: "gobranch", name: "branch") { ${numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { title } ... on PullRequest { title } }`).join(' ')} } }`;
  try {
    const { stdout } = await run('/opt/homebrew/bin/gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: 30000 });
    const repo = JSON.parse(stdout).data?.repository || {};
    return Object.fromEntries(numbers.filter((n) => repo[`n${n}`]?.title).map((n) => [n, repo[`n${n}`].title]));
  } catch {
    return {};
  }
}

async function readSlots(host, run = exec) {
  const text = await host(SCRIPT);
  let status;
  try {
    status = JSON.parse(text);
  } catch {
    throw new Error(`slots.py status --json returned text, not JSON: "${text.trim().split('\n')[0].slice(0, 60)}"`);
  }
  const keys = [...status.queue.map((q) => q.key), ...status.recent.map((r) => r.text?.split(' ')[2] || '')];
  return { ...status, titles: await readTitles(keys, run) };
}

// Keys hold a PR or issue number (review:<N>:<date>, bugfix:<N>, nt:<N>) or a Slack ts (hotfix:<ts>, …).
function describe(key, titles = {}) {
  const n = /(?:^|:)(review|bugfix|nt):(\d+)/.exec(key);
  if (n) return { label: `#${n[2]}`, url: `${REPO}/${n[1] === 'review' ? 'pull' : 'issues'}/${n[2]}`, ...(titles[n[2]] && { title: titles[n[2]] }) };
  const ts = /(?:^|:)(?:hotfix|mention|ease):(\d+)\.\d+/.exec(key);
  if (ts) {
    const at = new Date(Number(ts[1]) * 1000);
    return { label: 'Slack message', at: at.getTime() };
  }
  return { label: key };
}

// "started review review:38647:2026-11-11: started", "queued bugfix bugfix:38599 (priority 60)".
function parseRecent({ at, text, workspace }, titles) {
  const m = /^(queued|started|skipped|error|retry|expired) (\S+) (\S+?)(?: \(priority \d+\))?(?:: (.*))?$/.exec(text || '');
  if (!m) return { at: Date.parse(at), verb: 'other', kind: '', key: '', what: { label: text || '' }, note: '', workspace };
  return { at: Date.parse(at), verb: m[1], kind: m[2], key: m[3], what: describe(m[3], titles), note: m[4] || '', workspace };
}

// The card's data, with workspace names matched to Roost's Orca workspaces so they open in Orca and show their note.
function summarize(status, workspaces = [], now = Date.now(), easePosts = []) {
  const byName = new Map(workspaces.filter((w) => w.host === 'vm').map((w) => [w.path?.split('/').pop(), w]));
  const ws = (name) => ({ name, key: byName.get(name)?.key || null });
  const detail = (name) => {
    if (!name) return null;
    const w = byName.get(name);
    return { name, key: w?.key || null, title: w?.name || '', comment: w?.comment || '' };
  };
  // A Slack row has no ticket title; its workspace's title says what the agent took on.
  // An ease row takes its Ease post's title, Slack thread and verdict.
  const posts = new Map(easePosts.map((p) => [p.ts, p]));
  const withTitle = (row) => {
    const post = posts.get(/^ease:(\d+\.\d+)$/.exec(row.key)?.[1]);
    if (post) return { ...row, what: { ...row.what, title: post.title, url: post.link }, outcome: post.summary?.reason || '' };
    return row.what.title || !row.workspace?.title ? row : { ...row, what: { ...row.what, title: row.workspace.title } };
  };
  const titles = status.titles || {};
  const queue = status.queue.map((q) => withTitle({ ...q, what: describe(q.key, titles), waitedMs: now - Date.parse(q.queuedAt), workspace: detail(q.workspace) }));
  const recent = status.recent.map((r) => parseRecent(r, titles)).map((r) => withTitle({ ...r, workspace: detail(r.workspace) }));
  const lastStart = recent.find((r) => r.verb === 'started')?.at || 0;
  const stuck = !status.paused && queue.some((q) => q.fitsNow && q.waitedMs > STUCK_MS) && now - lastStart > GRACE_MS + STUCK_MS;
  return {
    at: Date.parse(status.at),
    budget: status.budget,
    used: status.used,
    paused: status.paused,
    kinds: Object.entries(status.kinds).map(([kind, k]) => ({ kind, weight: k.weight, most: k.most, running: k.running.map(ws) })),
    queue,
    recent,
    stuck
  };
}

module.exports = { readSlots, describe, parseRecent, summarize, STUCK_MS };
