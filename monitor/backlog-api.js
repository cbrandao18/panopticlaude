// The Staff backlog pass's live status: which tickets to build next, what still needs Christie, and how many
// are still unsorted over time. process-updates backlog-pass/status.py writes it hourly on the VM; this only reads it.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runOnHost } = require('./security-api');

const exec = promisify(execFile);
const GH = '/opt/homebrew/bin/gh';

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
  const read = () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= backlogData(host)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: String(e.message).slice(0, 300) }))
      .finally(() => { pending = null; });
    return pending;
  };
  read.clear = () => { cached = null; };
  return read;
}

// --- Answers --------------------------------------------------------------------------------------------
// Christie answers the pass's asks here. Each answer is one GitHub write as her (the field workflow, a close or a
// comment, with exactly the text she typed) or none, then a line in decisions.jsonl on the VM, which status.py
// and the overnight agents read. A note is private: it reaches the agents, not the ticket.
const TEAMS = ['Staff', 'Non-Staff', 'Integrations'];
const STATUSES = ['To Do (Dev)', 'Backlog (Dev)', 'Needs Refinement'];
const CLOSE = ['not planned', 'completed'];
const MAX_TEXT = 4000;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function backlogNumbers(data) {
  const groups = [...(data.needsYou || []), ...(data.tiers || [])].map((g) => g.tickets).concat([data.answered || [], data.remainingTickets || []]);
  return new Set(groups.flat().map((t) => t.number));
}

async function answer(body, { run = exec, host = runOnHost, read, now = () => new Date() }) {
  const { action } = body;
  const value = text(body.value);
  const note = text(body.note);
  const comment = text(body.comment);
  if (note.length > MAX_TEXT || comment.length > MAX_TEXT) throw bad('Keep it under 4,000 characters.');
  const data = await read();
  if (data.error) throw Object.assign(new Error(`Backlog status unavailable: ${data.error}`), { status: 503 });
  const line = { at: now().toISOString(), action };
  let ghArgs = null;
  if (action === 'question') {
    const question = text(body.question);
    if (!(data.questions || []).some((q) => q.text === question)) throw bad('Unknown question.');
    if (!['yes', 'no'].includes(value)) throw bad('Answer yes or no.');
    Object.assign(line, { question, value });
  } else {
    const number = body.number;
    if (!Number.isInteger(number) || !backlogNumbers(data).has(number)) throw bad('That ticket isn’t in the backlog pass.');
    line.number = number;
    if (action === 'team' || action === 'status') {
      if (!(action === 'team' ? TEAMS : STATUSES).includes(value)) throw bad('Unknown value.');
      const changes = JSON.stringify([{ issue: number, fields: { [action === 'team' ? 'Dev Team' : 'Status']: value } }]);
      ghArgs = ['workflow', 'run', 'branch-tech-update-fields.yml', '-R', 'gobranch/branch', '-f', `changes=${changes}`, '-f', 'dry_run=false'];
    } else if (action === 'close') {
      if (!CLOSE.includes(value)) throw bad('Close as not planned or completed.');
      ghArgs = ['issue', 'close', String(number), '-R', 'gobranch/branch', '--reason', value, ...(comment ? ['--comment', comment] : [])];
    } else if (action === 'comment') {
      if (!comment) throw bad('Write the comment first.');
      ghArgs = ['issue', 'comment', String(number), '-R', 'gobranch/branch', '--body', comment];
    } else if (!['keep', 'note', 'skip'].includes(action)) {
      throw bad('Unknown action.');
    } else if (action === 'note' && !note) {
      throw bad('Write the note first.');
    }
    if (value) line.value = value;
  }
  if (note) line.note = note;
  if (comment) line.comment = comment;
  if (ghArgs) {
    const { stdout } = await run(GH, ghArgs, { timeout: 30000 });
    line.url = (stdout.match(/https:\/\/github\.com\/\S+/) || [])[0] || '';
  }
  try {
    await recordOnVm(host, line);
  } catch {
    return { recorded: false, url: line.url || null, at: line.at, warning: line.url ? 'Done on GitHub, but the VM didn’t record it, so the ask may stay listed.' : 'The VM didn’t record it. Try again.' };
  }
  return { recorded: true, url: line.url || null, at: line.at };
}

function recordOnVm(host, line) {
  const encoded = Buffer.from(`${JSON.stringify(line)}\n`).toString('base64');
  return host([
    'mkdir -p ~/.local/state/backlog-pass',
    `echo ${encoded} | base64 -d >> ~/.local/state/backlog-pass/decisions.jsonl`,
    'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start --no-block backlog-status.service || true'
  ].join('\n'));
}

module.exports = { backlogData, createBacklogReader, answer };
