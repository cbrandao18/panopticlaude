// Christie's open, non-draft gobranch/branch PRs, split into ones GitHub would merge now without an
// admin bypass and ones that still wait on something. Read-only: merging stays manual.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
// CLEAN: every requirement met. HAS_HOOKS: same, with pre-receive hooks. UNSTABLE: only non-required checks failing.
const MERGEABLE = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

// Search results report mergeStateStatus as UNKNOWN, so this uses gh pr list, which computes it.
async function readPrs(run = exec) {
  const { stdout } = await run('/opt/homebrew/bin/gh', [
    'pr', 'list', '-R', 'gobranch/branch', '--author', '@me', '--state', 'open', '--limit', '200',
    '--json', 'number,title,url,isDraft,mergeStateStatus,reviewDecision,updatedAt'
  ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function waitingOn(pr) {
  if (pr.mergeStateStatus === 'DIRTY') return 'conflicts with trunk';
  if (pr.mergeStateStatus === 'BEHIND') return 'behind trunk';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'needs approval';
  if (pr.mergeStateStatus === 'BLOCKED') return 'required checks';
  return 'GitHub still checking';
}

function split(prs) {
  const ready = [];
  const waiting = [];
  for (const pr of prs.filter((p) => !p.isDraft).sort((a, b) => a.number - b.number)) {
    const item = { number: pr.number, title: pr.title, url: pr.url };
    if (MERGEABLE.has(pr.mergeStateStatus)) ready.push({ ...item, unstable: pr.mergeStateStatus === 'UNSTABLE' });
    else waiting.push({ ...item, reason: waitingOn(pr) });
  }
  return { ready, waiting };
}

function createMergeReader({ read = readPrs } = {}, ttl = 120000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= read()
      .then((prs) => (cached = { refreshedAt: Date.now(), ...split(prs) }))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read your PRs: ${String(e.message).slice(0, 200)}`, ready: [], waiting: [] }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { split, waitingOn, createMergeReader };
