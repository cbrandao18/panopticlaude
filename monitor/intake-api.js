// The GitHub Actions new-ticket intake (ai-new-ticket.yml in gobranch/branch): whether it writes to tickets,
// its last 24 hours of runs by outcome, failed runs, and the tickets its apply job flagged for review.
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
// Homebrew's gh on the Mac, as the other cards use; whatever gh is on PATH elsewhere (the VM).
const GH = fs.existsSync('/opt/homebrew/bin/gh') ? '/opt/homebrew/bin/gh' : 'gh';
const REPO = 'gobranch/branch';
const WORKFLOW = 'ai-new-ticket.yml';
const WORKFLOW_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
const DAY_MS = 86400000;
// Each run costs two gh calls the first time it's seen; completed runs are cached, so this caps a cold refresh.
const MAX_REVIEWED_RUNS = 20;
// bot_writes.py: "::warning::#<issue>: <n> item(s) need review; see the job summary".
const NEEDS_REVIEW = /^#(\d+): (\d+) item\(s\) need review/;

function outcome(r) {
  if (r.status !== 'completed') return 'running';
  if (['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) return 'failed';
  return r.conclusion || 'unknown';
}

// Needs-review annotations on one run's apply job. A completed run never changes, so its answer is cached.
const reviewCache = new Map();
async function runReviews(r, gh) {
  if (reviewCache.has(r.databaseId)) return reviewCache.get(r.databaseId);
  const { jobs } = JSON.parse(await gh(['run', 'view', String(r.databaseId), '--repo', REPO, '--json', 'jobs']));
  const apply = jobs.filter((j) => j.name === 'apply' && j.conclusion && j.conclusion !== 'skipped');
  const notes = (await Promise.all(apply.map((j) => gh(['api', `repos/${REPO}/check-runs/${j.databaseId}/annotations`]).then(JSON.parse)))).flat();
  const reviews = notes
    .map((a) => NEEDS_REVIEW.exec(a.message || ''))
    .filter(Boolean)
    .map((m) => ({ issue: Number(m[1]), items: Number(m[2]), url: r.url, at: Date.parse(r.createdAt) }));
  reviewCache.set(r.databaseId, reviews);
  return reviews;
}

async function readIntake(run = exec, now = Date.now()) {
  const gh = (args) => run(GH, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);
  const [live, listed] = await Promise.all([
    // A missing variable means dry run; any other gh failure is a read error.
    gh(['variable', 'get', 'AI_INTAKE_LIVE', '--repo', REPO]).then((t) => t.trim(), (e) => {
      if (/not found/i.test(`${e.stderr || ''} ${e.message}`)) return '';
      throw e;
    }),
    gh(['run', 'list', '--repo', REPO, '--workflow', WORKFLOW, '--limit', '50', '--json', 'databaseId,event,status,conclusion,createdAt,displayTitle,url']).then(JSON.parse)
  ]);
  const runs = listed.filter((r) => now - Date.parse(r.createdAt) < DAY_MS).map((r) => ({ ...r, outcome: outcome(r) }));
  const finished = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'skipped');
  const done = finished.slice(0, MAX_REVIEWED_RUNS);
  const reviews = (await Promise.all(done.map((r) => runReviews(r, gh)))).flat();
  for (const id of reviewCache.keys()) if (!runs.some((r) => r.databaseId === id)) reviewCache.delete(id);
  return { live: live === 'true', liveValue: live, runs, reviews, unchecked: finished.length - done.length, at: now };
}

// The card's data: counts by outcome, failed runs, and needs-review items, newest first.
function summarize({ live, liveValue, runs, reviews, unchecked = 0, at }) {
  const counts = { success: 0, skipped: 0, failed: 0, running: 0 };
  for (const r of runs) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  const failed = runs
    .filter((r) => r.outcome === 'failed')
    .map((r) => ({ title: r.displayTitle, url: r.url, at: Date.parse(r.createdAt), event: r.event }));
  return { live, liveValue, at, url: WORKFLOW_URL, total: runs.length, counts, failed, unchecked, reviews: [...reviews].sort((a, b) => b.at - a.at) };
}

module.exports = { readIntake, summarize, outcome, reviewCache, MAX_REVIEWED_RUNS };
