// Deploy coordinator state for the Deploys panel, plus the heartbeat alarm. Read-only: the Mac deployer writes
// <root>/envs/state/*.json and the synced repo carries them here. Every read can fail (the deployer may not be
// enabled yet), so a missing file becomes an error field, never a throw.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_ROOT = path.join(os.homedir(), 'branch-agents/projects/process-updates');
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.local/state/panopticlaude/deploy-heartbeat.json');
const STALE_MS = 45 * 60000;
const LOG_LINES = 50;
const PR_URL = 'https://github.com/gobranch/branch/pull/';

const readText = (file) => { try { return [fs.readFileSync(file, 'utf8'), null]; } catch (e) { return [null, e.code === 'ENOENT' ? 'not found' : e.message]; } };
function readJson(file) {
  const [text, error] = readText(file);
  if (error) return [null, error];
  try { return [JSON.parse(text), null]; } catch (e) { return [null, `not valid JSON (${e.message})`]; }
}

function entryRow(key, e) {
  const pr = /^pr:(\d+)$/.exec(key);
  return { key, label: pr ? `#${pr[1]}` : key.replace(/^branch:/, ''), status: e.status || 'waiting', since: e.since || null, note: e.note || '', url: pr ? PR_URL + pr[1] : null };
}

function envRow(root, env) {
  const [settings] = readJson(path.join(root, 'envs', `${env}.json`));
  const [state, error] = readJson(path.join(root, 'envs/state', `${env}.json`));
  const base = { env, branch: settings?.branch || null, staffUrl: settings?.staff_url || null };
  if (error) return { ...base, error: `No deployer state for ${env}: ${error}.`, entries: [], flags: [] };
  return {
    ...base,
    head: state.branch_head ? String(state.branch_head).slice(0, 7) : null,
    pinnedTrunk: state.pinned_date || null,
    lastRun: state.last_run || null,
    lock: state.lock_holder || null,
    entries: Object.entries(state.entries || {}).map(([key, e]) => entryRow(key, e || {})),
    flags: Object.entries(state.flags || {}).map(([key, f]) => ({ key, message: f?.message || key, since: f?.since || null }))
  };
}

function readLog(root) {
  const [text] = readText(path.join(root, 'envs/state/deploys.log'));
  return (text || '').split('\n').filter(Boolean).slice(-LOG_LINES).map((line) => {
    const m = /^(\S+) (\S+) (.*)$/.exec(line);
    return m ? { time: Date.parse(m[1]) || null, env: m[2], text: m[3] } : { time: null, env: null, text: line };
  });
}

// lastGate is the deployer's last gate run, or null when heartbeat.json is missing or unreadable.
function readGate(root) {
  const [hb] = readJson(path.join(root, 'envs/state/heartbeat.json'));
  const ms = Date.parse(hb?.last_gate);
  return Number.isFinite(ms) ? { iso: hb.last_gate, ms } : null;
}

async function deploysData({ root = DEFAULT_ROOT, now = Date.now() } = {}) {
  const gate = readGate(root);
  const out = { refreshedAt: now, stale: !gate || now - gate.ms > STALE_MS, lastGate: gate?.iso || null, envs: [], log: readLog(root) };
  try {
    const names = fs.readdirSync(path.join(root, 'envs')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    out.envs = names.map((env) => envRow(root, env));
  } catch (e) {
    out.error = `Couldn't read the deploy environments: ${e.code === 'ENOENT' ? 'envs folder not found' : e.message}.`;
  }
  return out;
}

function createDeploysReader(options = {}, ttl = 30000) {
  let cached = null;
  let pending = null;
  const read = () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= deploysData(options)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read the deploy state: ${String(e.message).slice(0, 200)}`, stale: true, lastGate: null, envs: [], log: [] }))
      .finally(() => { pending = null; });
    return pending;
  };
  read.clear = () => { cached = null; };
  return read;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);

// Notifies once per stale episode. An episode is keyed by the last_gate it began with, and clears when the
// heartbeat is fresh again. A heartbeat that never existed means the deployer isn't enabled: banner only.
async function checkHeartbeat({ root = DEFAULT_ROOT, now = Date.now(), notify, statePath = DEFAULT_STATE_PATH }) {
  const gate = readGate(root);
  if (!gate) return { stale: true, notified: false };
  const stale = now - gate.ms > STALE_MS;
  const [recorded] = readJson(statePath);
  const record = (notifiedFor) => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ notifiedFor }));
  };
  if (!stale) {
    if (recorded?.notifiedFor) record(null);
    return { stale, notified: false };
  }
  if (recorded?.notifiedFor === gate.iso) return { stale, notified: false };
  await notify(`The deployer hasn't checked in since ${clock(gate.ms)}.`);
  record(gate.iso);
  return { stale, notified: true };
}

const escapeAppleScript = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const osascriptNotify = (text) => new Promise((resolve) => {
  execFile('/usr/bin/osascript', ['-e', `display notification "${escapeAppleScript(text)}" with title "Roost"`], { timeout: 10000 }, () => {
    console.log(`Deploy heartbeat notification sent: ${text}`);
    resolve();
  });
});

// Checks now, then every 5 minutes. unref so it never keeps a process (or a test) alive on its own.
function startHeartbeatTimer(options = {}, every = 5 * 60000) {
  const run = () => checkHeartbeat({ notify: osascriptNotify, ...options }).catch((e) => console.error(`Deploy heartbeat check failed: ${e.message}`));
  run();
  return setInterval(run, every).unref();
}

module.exports = { deploysData, createDeploysReader, checkHeartbeat, escapeAppleScript, startHeartbeatTimer, DEFAULT_ROOT, DEFAULT_STATE_PATH };
