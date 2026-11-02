const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const stateDir = path.join(os.homedir(), '.local/state/github-ticket-work');
const wrapper = path.join(os.homedir(), 'branch-agents/projects/process-updates/github-ticket-work/refresh.py');
function validSnapshot(data) {
  const textFields = (value, keys) => value && keys.every(key => typeof value[key] === 'string');
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  return data && data.schema === 1 && Number.isFinite(Date.parse(data.refreshedAt)) &&
    Array.isArray(data.projects) && data.projects.every(p => textFields(p, ['id','name']) && typeof p.assessed === 'boolean') &&
    Array.isArray(data.tickets) && data.tickets.every(t =>
      textFields(t, ['repo','title','url','category','reason','owner','nextAction','state','boardStatus','observedAt']) &&
      Number.isInteger(t.number) && strings(t.projects) &&
      Array.isArray(t.actions) && t.actions.every(a => textFields(a, ['text','owner','source','recordedAt','state']) && ['open','resolved'].includes(a.state)) &&
      Array.isArray(t.prs) && t.prs.every(p => textFields(p, ['title','url','state','head','ci','review']) && Number.isInteger(p.number) && typeof p.isDraft === 'boolean' && strings(p.reviewers)));
}
let refreshError = null;
function readPriorities(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    if (!Array.isArray(rows) || !rows.every(r => {
      if (!r || !Number.isInteger(r.pr) || r.pr <= 0 || seen.has(r.pr) || !Number.isInteger(r.rank) || r.rank < 1) return false;
      seen.add(r.pr);
      return ['head','reason','nextAction','assessedAt','source'].every(k => typeof r[k] === 'string' && r[k].length > 0 && r[k].length <= 900) &&
        /^[a-f0-9]{40}$/.test(r.head) && Number.isFinite(Date.parse(r.assessedAt)) &&
        r.source === `https://github.com/gobranch/branch/pull/${r.pr}` &&
        ['blockedReason','excludedReason'].every(k => r[k] === undefined || (typeof r[k] === 'string' && r[k].length <= 900));
    })) throw Error('Invalid priorities');
    return { priorities: rows, priorityError: null };
  } catch { return { priorities: [], priorityError: 'PR priorities need assessment or repair. Live ticket status remains available.' }; }
}
function ticketData(dir = stateDir, priorityFile = path.join(os.homedir(), 'branch-agents/projects/process-updates/github-ticket-work/pr-priorities.json')) {
  let snapshot = null;
  let health = { error: null, running: false, lastAttemptAt: null };
  try { health = { ...health, ...JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') health.error = 'Could not read refresh status.'; }
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    if (!validSnapshot(data)) throw Error('Invalid');
    snapshot = data;
  } catch { health.error ||= 'Ticket snapshot unavailable. Run Refresh to collect it.'; }
  if (health.running && Date.now() - Date.parse(health.lastAttemptAt) > 12 * 60 * 1000) {
    health.running = false;
    health.error ||= 'Last refresh did not finish. Retry Refresh.';
  }
  health.error ||= refreshError;
  return { snapshot, health, ...readPriorities(priorityFile), stale: !snapshot || Boolean(health.error) || Date.now() - Date.parse(snapshot.refreshedAt) > 30 * 60 * 1000 };
}
function createRefresh(run = () => promisify(execFile)('/opt/homebrew/bin/python3', [wrapper], { timeout: 700000, maxBuffer: 1024 * 1024 })) {
  let running = false;
  return () => {
    if (running) return false;
    running = true;
    refreshError = null;
    Promise.resolve().then(run).catch(() => { refreshError = 'Refresh could not complete. Check the refresh service and retry.'; }).finally(() => { running = false; });
    return true;
  };
}
const startRefresh = createRefresh();
module.exports = { ticketData, createRefresh, startRefresh };
