// Data layer for panopticlaude. No vscode import: `node --test` runs against this,
// and scripts/live-check.js prints real rows outside the extension host.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATE_DIR = path.join(CLAUDE_DIR, 'panopticlaude');

function slugifyCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptPath(cwd, sessionId) {
  return path.join(CLAUDE_DIR, 'projects', slugifyCwd(cwd), sessionId + '.jsonl');
}

function readTail(file, bytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Last assistant entry carries the current window usage; any recent entry carries gitBranch.
// The first line of a tail read from a byte offset is usually partial JSON: JSON.parse
// failures are expected and skipped.
function parseTranscriptTail(tailText) {
  const lines = tailText.split('\n').filter(Boolean);
  let model = null;
  let usedTokens = null;
  let gitBranch = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (gitBranch === null) {
      const m = line.match(/"gitBranch":"([^"]+)"/);
      if (m) gitBranch = m[1];
    }
    if (usedTokens === null && line.includes('"type":"assistant"') && line.includes('"usage"')) {
      try {
        const entry = JSON.parse(line);
        const usage = entry.message && entry.message.usage;
        if (usage) {
          usedTokens =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          model = entry.message.model || null;
        }
      } catch {}
    }
    if (usedTokens !== null && gitBranch !== null) break;
  }
  return { model, usedTokens, gitBranch };
}

// ponytail: window size inferred from the configured model's [1m] suffix; per-session
// overrides aren't visible outside the session. Revisit if that ever matters.
function contextWindowSize(settingsModel) {
  return /\[1m\]/.test(settingsModel || '') ? 1_000_000 : 200_000;
}

function pctUsed(usedTokens, windowSize) {
  if (usedTokens == null || !windowSize) return null;
  return Math.min(100, Math.round((usedTokens / windowSize) * 100));
}

function issueNumberFromBranch(branch) {
  const m = (branch || '').match(/(\d{4,})/);
  return m ? Number(m[1]) : null;
}

// git@github.com:owner/repo.git | https://github.com/owner/repo(.git) -> https://github.com/owner/repo
function repoUrlFromRemote(remote) {
  const m = (remote || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// ~/.claude/sessions/<pid>.json is the registry `claude agents --json` reads; reading it
// directly avoids spawning the CLI every poll. Entries whose pid is gone are stale.
function listLiveSessions() {
  let files;
  try {
    files = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8'));
      process.kill(reg.pid, 0); // throws if the process is gone
      out.push(reg);
    } catch {}
  }
  return out;
}

// ~/.claude/history.jsonl appends {display, sessionId, ...} per typed prompt. Last one
// per session wins. sessionIds survive process restarts, so this is the stable way to
// recognize a chat (derived names like "branch-ad" regenerate on every restart).
function parseHistoryTail(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.sessionId && e.display) map.set(e.sessionId, e.display);
    } catch {}
  }
  return map;
}

function lastPromptsBySession() {
  try {
    return parseHistoryTail(readTail(path.join(CLAUDE_DIR, 'history.jsonl'), 262144));
  } catch {
    return new Map();
  }
}

// Hook-written state wins; without it, a transcript touched in the last 10s means running.
function sessionState(sessionId, transcriptMtimeMs, nowMs = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, sessionId + '.json'), 'utf8'));
    if (s.state) return s;
  } catch {}
  if (transcriptMtimeMs && nowMs - transcriptMtimeMs < 10_000) return { state: 'running' };
  return { state: 'idle' };
}

function sessionSnapshot(reg, settings) {
  const snap = {
    name: reg.name || String(reg.pid),
    nameSource: reg.nameSource || null,
    pid: reg.pid,
    sessionId: reg.sessionId,
    cwd: reg.cwd,
    startedAt: reg.startedAt,
    model: null,
    pct: null,
    gitBranch: null,
    state: 'idle',
    effort: (settings && settings.effortLevel) || null,
    transcript: transcriptPath(reg.cwd, reg.sessionId),
  };
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(snap.transcript).mtimeMs;
    const tail = parseTranscriptTail(readTail(snap.transcript));
    snap.model = tail.model;
    snap.gitBranch = tail.gitBranch;
    snap.pct = pctUsed(tail.usedTokens, contextWindowSize(settings && settings.model));
  } catch {}
  const state = sessionState(reg.sessionId, mtimeMs);
  snap.state = state.state;
  if (state.effort) snap.effort = state.effort;
  return snap;
}

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// --- crons ---

function scheduleFromPlist(plistJson) {
  const cal = plistJson && plistJson.StartCalendarInterval;
  if (!cal) return null;
  const one = Array.isArray(cal) ? cal[0] : cal;
  if (one == null || one.Hour == null) return null;
  return `${String(one.Hour).padStart(2, '0')}:${String(one.Minute || 0).padStart(2, '0')}`;
}

// launchctl prints "last exit code = 0" or "last exit code = (never exited)".
function lastExitCodeFromLaunchctl(text) {
  const m = (text || '').match(/last exit (?:code|status)\s*=\s*([^\n]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return v.includes('never') ? 'never-exited' : v;
}

// Overdue = past today's schedule (+15 min grace) with no log write since the scheduled time.
function cronOverdue(scheduleHHMM, logMtimeMs, nowMs = Date.now()) {
  if (!scheduleHHMM || !logMtimeMs) return false;
  const [h, min] = scheduleHHMM.split(':').map(Number);
  const sched = new Date(nowMs);
  sched.setHours(h, min, 0, 0);
  const GRACE_MS = 15 * 60 * 1000;
  return nowMs > sched.getTime() + GRACE_MS && logMtimeMs < sched.getTime();
}

function inboxCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch {
    return null;
  }
}

module.exports = {
  CLAUDE_DIR,
  STATE_DIR,
  slugifyCwd,
  transcriptPath,
  readTail,
  parseTranscriptTail,
  contextWindowSize,
  pctUsed,
  issueNumberFromBranch,
  repoUrlFromRemote,
  listLiveSessions,
  parseHistoryTail,
  lastPromptsBySession,
  sessionState,
  sessionSnapshot,
  readClaudeSettings,
  scheduleFromPlist,
  lastExitCodeFromLaunchctl,
  cronOverdue,
  inboxCount,
};
