// The VM's agent slot queue (process-updates slots/slots.py): what runs per kind, what starts next, what just
// started or got skipped. One `slots.py status --json` call over the same host runner as the other VM cards.
const STUCK_MS = 15 * 60000;
const SCRIPT = '. ~/orca/projects/daily-brief/env.sh && /usr/bin/python3 ~/branch-agents/projects/process-updates/slots/slots.py status --json';
const REPO = 'https://github.com/gobranch/branch';

const readSlots = (host) => host(SCRIPT).then((text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`slots.py status --json returned text, not JSON: "${text.trim().split('\n')[0].slice(0, 60)}"`);
  }
});

// Keys hold a PR or issue number (review:<N>:<date>, bugfix:<N>, nt:<N>) or a Slack ts (hotfix:<ts>, …).
function describe(key) {
  const n = /(?:^|:)(review|bugfix|nt):(\d+)/.exec(key);
  if (n) return { label: `#${n[2]}`, url: `${REPO}/${n[1] === 'review' ? 'pull' : 'issues'}/${n[2]}` };
  const ts = /(?:^|:)(?:hotfix|mention|ease):(\d+)\.\d+/.exec(key);
  if (ts) {
    const at = new Date(Number(ts[1]) * 1000);
    return { label: 'Slack message', at: at.getTime() };
  }
  return { label: key };
}

// "started review review:38647:2026-11-11: started", "queued bugfix bugfix:38599 (priority 60)".
function parseRecent({ at, text }) {
  const m = /^(queued|started|skipped|error|retry|expired) (\S+) (\S+?)(?: \(priority \d+\))?(?:: (.*))?$/.exec(text || '');
  if (!m) return { at: Date.parse(at), verb: 'other', kind: '', key: '', what: { label: text || '' }, note: '' };
  return { at: Date.parse(at), verb: m[1], kind: m[2], key: m[3], what: describe(m[3]), note: m[4] || '' };
}

// The card's data, with workspace names matched to Roost's Orca workspaces so they open in Orca.
function summarize(status, workspaces = [], now = Date.now()) {
  const byName = new Map(workspaces.filter((w) => w.host === 'vm').map((w) => [w.path?.split('/').pop(), w.key]));
  const ws = (name) => ({ name, key: byName.get(name) || null });
  const queue = status.queue.map((q) => ({ ...q, what: describe(q.key), waitedMs: now - Date.parse(q.queuedAt), workspace: q.workspace ? ws(q.workspace) : null }));
  const recent = status.recent.map(parseRecent);
  const lastStart = recent.find((r) => r.verb === 'started')?.at || 0;
  const stuck = !status.paused && queue.some((q) => q.fitsNow && q.waitedMs > STUCK_MS) && now - lastStart > STUCK_MS;
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
