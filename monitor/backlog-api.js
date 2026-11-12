// The Staff backlog pass's live status: which tickets to build next, what still needs Christie, and how many
// are still unsorted over time. process-updates backlog-pass/status.py writes it hourly on the VM; this only reads it.
const { runOnHost } = require('./security-api');

const SCRIPT = 'cat ~/.local/state/backlog-pass/status.json 2>/dev/null || true';
const STALE_MS = 3 * 3600000;
// status.py SORTED: prioritized, being built, closed or with another team.
const SORTED = new Set(['done', 'dropped', 'other-team', 'building', 'ready']);

async function backlogData(host = runOnHost, now = Date.now()) {
  const text = await host(SCRIPT);
  if (!text.trim()) throw new Error('No backlog status yet: backlog-status.timer on the VM writes it hourly');
  const data = JSON.parse(text);
  const trend = (data.history || []).map((h) => {
    const counts = Object.entries(h.counts || {});
    return {
      date: h.date,
      remaining: counts.filter(([k]) => !SORTED.has(k)).reduce((n, [, v]) => n + v, 0),
      total: counts.reduce((n, [, v]) => n + v, 0),
      baseline: Boolean(h.baseline)
    };
  });
  return { ...data, trend, stale: now - Date.parse(data.at) > STALE_MS, refreshedAt: now };
}

function createBacklogReader({ host = runOnHost } = {}, ttl = 300000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= backlogData(host)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: String(e.message).slice(0, 300) }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { backlogData, createBacklogReader };
