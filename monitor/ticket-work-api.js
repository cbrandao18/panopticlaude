const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const stateDir = path.join(os.homedir(), '.local/state/github-ticket-work');
const wrapper = path.join(os.homedir(), 'branch-agents/projects/process-updates/github-ticket-work/refresh.py');
function ticketData(dir = stateDir) {
  let snapshot = null;
  let health = { error: null, running: false, lastAttemptAt: null };
  try { health = { ...health, ...JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') health.error = 'Could not read refresh status.'; }
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
    if (data.schema !== 1 || !Array.isArray(data.tickets) || !Array.isArray(data.projects) || !Number.isFinite(Date.parse(data.refreshedAt))) throw Error('Invalid');
    snapshot = data;
  } catch { health.error ||= 'Ticket snapshot unavailable. Run Refresh to collect it.'; }
  if (health.running && Date.now() - Date.parse(health.lastAttemptAt) > 12 * 60 * 1000) {
    health.running = false;
    health.error ||= 'Last refresh did not finish. Retry Refresh.';
  }
  return { snapshot, health, stale: !snapshot || Boolean(health.error) || Date.now() - Date.parse(snapshot.refreshedAt) > 30 * 60 * 1000 };
}
function createRefresh(run = () => promisify(execFile)('/opt/homebrew/bin/python3', [wrapper], { timeout: 700000, maxBuffer: 1024 * 1024 })) {
  let running = false;
  return () => {
    if (running) return false;
    running = true;
    Promise.resolve().then(run).catch(() => {}).finally(() => { running = false; });
    return true;
  };
}
const startRefresh = createRefresh();
module.exports = { ticketData, createRefresh, startRefresh };
