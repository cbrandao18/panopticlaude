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
// A "user" entry is only a typed prompt when it isn't a tool result, a sidechain
// message, or harness noise (<command-name> invocations, resume caveats, interrupts).
function typedPromptFromEntry(entry) {
  if (!entry || entry.type !== 'user' || entry.isSidechain || entry.toolUseResult) return null;
  const content = entry.message && entry.message.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text');
    if (t) text = t.text;
  }
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return null;
  return text;
}

// A tool call betrays where the chat is really working: an Edit/Write file_path or a
// Bash `cd /abs/path`. The session-level cwd stays wherever the chat was opened, which
// misleads for chats driving a worktree.
function toolDirHint(line) {
  let m = line.match(/"file_path":"(\/(?:[^"\\]|\\.)+?)"/);
  if (m) return path.dirname(m[1]);
  m = line.match(/"command":"cd (\/[^ "\\&;]+)/);
  if (m) return m[1];
  return null;
}

const gitRootCache = new Map();
function findGitRoot(dir) {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir);
  let d = dir;
  let root = null;
  while (d && d !== path.dirname(d)) {
    try {
      if (fs.existsSync(path.join(d, '.git'))) {
        root = d;
        break;
      }
    } catch {}
    d = path.dirname(d);
  }
  gitRootCache.set(dir, root);
  return root;
}

function parseTranscriptTail(tailText) {
  const lines = tailText.split('\n').filter(Boolean);
  let model = null;
  let usedTokens = null;
  let gitBranch = null;
  let lastCwd = null;
  let lastUserPrompt = null;
  let aiTitle = null;
  let lastAssistantText = null;
  const hints = [];
  const editedFiles = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const hint = toolDirHint(line);
    if (hint) hints.push(hint);
    // Only mutating tools count as "files touched" — Read also carries file_path.
    for (const m of line.matchAll(/"name":"(?:Edit|Write|MultiEdit|NotebookEdit)".*?"file_path":"((?:[^"\\]|\\.)+?)"/g)) {
      editedFiles.add(m[1]);
    }
    if (gitBranch === null) {
      const m = line.match(/"gitBranch":"([^"]+)"/);
      if (m) gitBranch = m[1];
    }
    if (lastCwd === null) {
      const m = line.match(/"cwd":"([^"]+)"/);
      if (m) lastCwd = m[1];
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
    if (lastUserPrompt === null && line.includes('"type":"user"')) {
      try {
        lastUserPrompt = typedPromptFromEntry(JSON.parse(line));
      } catch {}
    }
    if (aiTitle === null && line.includes('"type":"ai-title"')) {
      try {
        const e = JSON.parse(line);
        if (e.aiTitle) aiTitle = e.aiTitle;
      } catch {}
    }
    if (lastAssistantText === null && line.includes('"type":"assistant"') && line.includes('"text"')) {
      try {
        const entry = JSON.parse(line);
        const content = entry.message && entry.message.content;
        if (Array.isArray(content)) {
          const texts = content.filter((c) => c && c.type === 'text' && c.text);
          if (texts.length) lastAssistantText = texts[texts.length - 1].text;
        }
      } catch {}
    }
  }
  return {
    model,
    usedTokens,
    gitBranch,
    lastCwd,
    lastUserPrompt,
    lastAssistantText,
    aiTitle,
    hints,
    editedFiles: [...editedFiles],
  };
}

// ponytail: majority vote over recent tool-call git roots; a chat splitting work evenly
// across two repos will show whichever edges ahead in the tail window.
function workRootFromHints(hints) {
  const counts = new Map();
  for (const h of hints) {
    const root = findGitRoot(h);
    if (root) counts.set(root, (counts.get(root) || 0) + 1);
  }
  let best = null;
  for (const [root, n] of counts) {
    if (!best || n > best.n) best = { root, n };
  }
  return best ? best.root : null;
}

// The chat's tab title lives in "ai-title" transcript entries (set when the user renames
// the chat or Claude titles it). A title set long ago can sit outside the tail window,
// so fall back to one full-file scan, re-run only when the file size changes.
const titleCache = new Map(); // sessionId -> { size, title }
function transcriptTitle(transcript, sessionId, tailTitle) {
  if (tailTitle) {
    titleCache.set(sessionId, { size: -1, title: tailTitle });
    return tailTitle;
  }
  try {
    const size = fs.statSync(transcript).size;
    const hit = titleCache.get(sessionId);
    if (hit && hit.size === size) return hit.title;
    const text = fs.readFileSync(transcript, 'utf8');
    let title = null;
    for (const m of text.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)) {
      title = JSON.parse('"' + m[1] + '"');
    }
    titleCache.set(sessionId, { size, title });
    return title;
  } catch {
    return null;
  }
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
  const m = (branch || '').match(/(\d{5,})/);
  return m ? Number(m[1]) : null;
}

// Central PR chip text so the tree and the GUI don't each rebuild the suffix:
// "PR #34079 (merged 2d ago)" | "PR #123 (closed)" | "PR #123".
function prLabel(pr, nowMs = Date.now()) {
  if (!pr) return null;
  let suffix = '';
  if (pr.state === 'MERGED' && pr.mergedAt) suffix = ` (merged ${relTime(Date.parse(pr.mergedAt), nowMs)})`;
  else if (pr.state && pr.state !== 'OPEN') suffix = ` (${pr.state.toLowerCase()})`;
  return `PR #${pr.number}${suffix}`;
}

// gh's statusCheckRollup mixes CheckRun {status, conclusion} and StatusContext {state}
// objects; a CheckRun still running has an empty conclusion.
const CI_FAIL = /^(FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED|CANCELLED|STARTUP_FAILURE)$/;
const CI_OK = /^(SUCCESS|NEUTRAL|SKIPPED)$/;
function ciState(rollup) {
  if (!rollup || !rollup.length) return null;
  let pending = false;
  for (const c of rollup) {
    const v = c.conclusion || c.state || c.status || '';
    if (CI_FAIL.test(v)) return 'failing';
    if (!CI_OK.test(v)) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

// One `gh pr list` entry -> display row. status drives the icon: bad (CI failing or
// changes requested) / good (approved and CI not pending) / pending (everything else).
function myPrRow(pr) {
  const ci = ciState(pr.statusCheckRollup);
  const status =
    ci === 'failing' || pr.reviewDecision === 'CHANGES_REQUESTED'
      ? 'bad'
      : pr.reviewDecision === 'APPROVED' && ci !== 'pending'
        ? 'good'
        : 'pending';
  const bits = ['#' + pr.number];
  if (pr.isDraft) bits.push('draft');
  if (pr.reviewDecision) bits.push(pr.reviewDecision.toLowerCase().replace(/_/g, ' '));
  if (ci) bits.push('CI ' + ci);
  if (pr.headRefName) bits.push(pr.headRefName);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: !!pr.isDraft,
    status,
    desc: bits.join(' · '),
    updatedAt: pr.updatedAt ? Date.parse(pr.updatedAt) : null,
  };
}

// `git worktree list --porcelain`: blank-line-separated stanzas, one per worktree; the
// first is the main checkout. `prunable` lines carry an optional reason after the word.
function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of (text || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, detached: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
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
    lastPrompt: null,
    title: null,
    askedQuestion: false,
    editedFiles: [],
    stateTs: null,
    workCwd: reg.cwd,
    transcript: transcriptPath(reg.cwd, reg.sessionId),
  };
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(snap.transcript).mtimeMs;
    // 256KB back: a tool-heavy turn can push the last typed prompt well past 64KB
    const tail = parseTranscriptTail(readTail(snap.transcript, 262144));
    snap.model = tail.model;
    snap.gitBranch = tail.gitBranch;
    snap.lastPrompt = tail.lastUserPrompt;
    snap.askedQuestion = /\?\s*$/.test((tail.lastAssistantText || '').trim());
    snap.editedFiles = tail.editedFiles;
    snap.title = transcriptTitle(snap.transcript, snap.sessionId, tail.aiTitle);
    // Where the chat actually works, best signal first: majority git root of recent
    // tool calls > per-entry cwd (updated when a session moves into a worktree) >
    // registry cwd (wherever the chat was opened).
    snap.workCwd = workRootFromHints(tail.hints) || tail.lastCwd || snap.workCwd;
    snap.pct = pctUsed(tail.usedTokens, contextWindowSize(settings && settings.model));
  } catch {}
  const state = sessionState(reg.sessionId, mtimeMs);
  snap.state = state.state;
  snap.stateTs = state.ts ? state.ts * 1000 : null; // hook writes epoch seconds
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

// Short age for row decorations: "3m", "2h", "1d".
function age(ms, nowMs = Date.now()) {
  if (!ms) return null;
  const s = Math.round((nowMs - ms) / 1000);
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function relTime(ms, nowMs = Date.now()) {
  if (!ms) return null;
  const s = Math.round((nowMs - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Next occurrence of a daily HH:MM schedule: today if still ahead, else tomorrow.
function nextRun(scheduleHHMM, nowMs = Date.now()) {
  if (!scheduleHHMM) return null;
  const [h, m] = scheduleHHMM.split(':').map(Number);
  const next = new Date(nowMs);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// Future-facing counterpart of age(): "19h" until the given time.
function untilTime(ms, nowMs = Date.now()) {
  if (!ms) return null;
  const s = Math.max(0, Math.round((ms - nowMs) / 1000));
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Claude Code's OAuth /usage endpoint: limits[] carries the same bars the CLI's
// /usage screen shows — session (5hr), weekly all-models, weekly per-model scoped.
function usageRows(json, nowMs = Date.now()) {
  const rows = [];
  for (const l of (json && json.limits) || []) {
    if (l.percent == null) continue;
    let label = l.kind;
    if (l.kind === 'session') label = 'Session (5hr)';
    else if (l.kind === 'weekly_all') label = 'Weekly (7 day)';
    else if (l.kind === 'weekly_scoped')
      label = ('Weekly ' + ((l.scope && l.scope.model && l.scope.model.display_name) || '')).trim();
    const resetMs = l.resets_at ? Date.parse(l.resets_at) : null;
    rows.push({
      label,
      pct: Math.round(l.percent),
      resets: resetMs ? 'Resets in ' + untilTime(resetMs, nowMs) : null,
      hot: (l.severity && l.severity !== 'normal') || l.percent >= 80,
    });
  }
  return rows;
}

function inboxCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch {
    return null;
  }
}

// "Mark inbox reviewed" snapshots {filename: mtimeMs}; the badge counts only files
// that are new or changed since — reviewed drafts can stay in the folder forever.
const SEEN_FILE = path.join(STATE_DIR, 'inbox-seen.json');

function loadInboxSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveInboxSeen(label, snapshot) {
  const all = loadInboxSeen();
  all[label] = snapshot;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(all, null, 2));
}

function snapshotInbox(dir) {
  const snap = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      snap[f] = fs.statSync(path.join(dir, f)).mtimeMs;
    }
  } catch {}
  return snap;
}

function unseenCount(snapshot, seen) {
  if (!seen) return Object.keys(snapshot).length;
  return Object.keys(snapshot).filter((f) => seen[f] !== snapshot[f]).length;
}

// --- assess-assumptions draft files (DRAFTS-YYYY-MM-DD.md in a cron's inbox dir) ---

function draftFileName(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `DRAFTS-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
}

// The date-stamped names sort lexicographically, so the newest file is the max.
function latestDraftFile(names) {
  return (
    (names || [])
      .filter((f) => /^DRAFTS-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .pop() || null
  );
}

// A sweep drafts file: optional `> **POSTED ...**` banner, then per-draft sections of
// `## Draft N — #ISSUE title` each containing one ```markdown fence — that fenced block
// is the comment body, verbatim. Draft bodies never contain bare ``` lines.
function parseDraftsFile(text) {
  const posted = /^> \*\*POSTED\b/m.test(text || '');
  const drafts = [];
  const re = /^## Draft (\d+) — #(\d+)([^\n]*)\n([\s\S]*?)(?=^## Draft |(?![\s\S]))/gm;
  for (const m of (text || '').matchAll(re)) {
    const fence = m[4].match(/^```markdown\n([\s\S]*?)^```\s*$/m);
    if (!fence) continue;
    drafts.push({ n: Number(m[1]), issue: Number(m[2]), title: m[3].trim(), body: fence[1] });
  }
  return { posted, drafts };
}

// Repo-relative links break in GitHub issue comments (they resolve against the issue
// URL, not the repo), so expand them to full blob URLs; http(s) and #anchor links pass.
function expandRelativeLinks(body, repo) {
  return (body || '').replace(/\]\((?!https?:\/\/|#)([^)]+)\)/g, `](https://github.com/${repo}/blob/trunk/$1)`);
}

function commentIdFromUrl(url) {
  const m = (url || '').match(/#issuecomment-(\d+)/);
  return m ? m[1] : null;
}

// Matches the sweep's hand-written banner convention so downstream sessions (and the
// cron's own dedup) read machine- and human-posted files identically.
function postedBanner(posted, notPosted, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const nums = posted.map((p) => p.n).join(', ');
  const refs = posted.map((p) => `#${p.issue} (issuecomment-${commentIdFromUrl(p.commentUrl) || '?'})`).join(', ');
  let line = `> **POSTED ${date}** — drafts ${nums} posted via panopticlaude: ${refs}.`;
  if (notPosted.length) {
    line += ` Drafts ${notPosted.map((p) => `${p.n} (#${p.issue})`).join(', ')} NOT posted — don't post later without asking.`;
  }
  return line + ' Do not re-post.';
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
  prLabel,
  ciState,
  myPrRow,
  parseWorktrees,
  repoUrlFromRemote,
  listLiveSessions,
  parseHistoryTail,
  lastPromptsBySession,
  transcriptTitle,
  toolDirHint,
  workRootFromHints,
  sessionState,
  sessionSnapshot,
  readClaudeSettings,
  scheduleFromPlist,
  lastExitCodeFromLaunchctl,
  cronOverdue,
  nextRun,
  untilTime,
  age,
  relTime,
  usageRows,
  inboxCount,
  loadInboxSeen,
  saveInboxSeen,
  snapshotInbox,
  unseenCount,
  draftFileName,
  latestDraftFile,
  parseDraftsFile,
  expandRelativeLinks,
  commentIdFromUrl,
  postedBanner,
};
