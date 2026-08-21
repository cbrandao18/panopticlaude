// panopticlaude: VSCode glue. All parsing lives in lib.js; this file collects row data
// (git/gh spawns, cached), renders it as either native trees or the webview GUI (the
// user toggles between them; the context key panopticlaude.gui picks which views show),
// and installs the Claude Code hooks.
const vscode = require('vscode');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(require('child_process').execFile);
const lib = require('./lib');

const PR_TTL_MS = 5 * 60 * 1000;
const CRON_TTL_MS = 60 * 1000;
const BRANCH_TTL_MS = 30 * 1000;
const WORKTREE_TTL_MS = 60 * 1000;
const remoteByCwd = new Map(); // cwd -> repo URL or null
const prByKey = new Map(); // `${cwd}|${branch}` -> { t, pr }
const branchByCwd = new Map(); // cwd -> { t, v }
let cronCache = { t: 0, rows: null };
let myPrCache = { t: 0, rows: null };
let worktreeCache = { t: 0, rows: null };
let usageCache = { t: 0, rows: null };
const USAGE_TTL_MS = 60 * 1000;

// The extension host's PATH lacks homebrew, so `gh` must be resolved absolutely.
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';

const expandHome = (p) => p && p.replace(/^~(?=$|\/)/, os.homedir());

function configuredRepos() {
  return (vscode.workspace.getConfiguration('panopticlaude').get('repos') || []).map(expandHome);
}

// Live checkout of where the chat works. The transcript's per-entry gitBranch reflects
// whatever the folder was on when each entry was written, which misleads once the
// checkout moves under an idle chat — the live value is the one that's always true.
async function liveBranch(cwd) {
  const hit = branchByCwd.get(cwd);
  if (hit && Date.now() - hit.t < BRANCH_TTL_MS) return hit.v;
  let v = null;
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'branch', '--show-current']);
    v = stdout.trim() || null;
  } catch {}
  branchByCwd.set(cwd, { t: Date.now(), v });
  return v;
}

async function repoUrl(cwd) {
  if (remoteByCwd.has(cwd)) return remoteByCwd.get(cwd);
  let url = null;
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
    url = lib.repoUrlFromRemote(stdout);
  } catch {}
  remoteByCwd.set(cwd, url);
  return url;
}

async function prForBranch(cwd, branch) {
  const key = cwd + '|' + branch;
  const hit = prByKey.get(key);
  if (hit && Date.now() - hit.t < PR_TTL_MS) return hit.pr;
  let pr = null;
  try {
    const { stdout } = await execFileP(
      GH,
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state,mergedAt', '--limit', '1'],
      { cwd }
    );
    const arr = JSON.parse(stdout);
    if (arr.length) pr = arr[0];
  } catch {}
  prByKey.set(key, { t: Date.now(), pr });
  return pr;
}

const STATE_ICON = {
  'needs-you': ['warning', 'charts.red'],
  question: ['question', 'charts.orange'],
  waiting: ['bell-dot', 'charts.yellow'],
  running: ['loading~spin', null],
  idle: ['circle-outline', 'disabledForeground'],
};
// Actionable first: permission prompts, then blocked-on-a-question, then review-when-
// convenient, then busy, then idle.
const STATE_RANK = { 'needs-you': 0, question: 1, waiting: 2, running: 3, idle: 4 };
// The icon carries running/idle; words only where the user must act.
const STATE_WORD = { 'needs-you': 'needs you', question: 'asked you', waiting: 'your turn' };
const ACTIONABLE = new Set(['needs-you', 'question', 'waiting']);

// "waiting" conflates "finished, review whenever" with "stalled on a question" — a
// closing question mark in the last assistant message is a cheap, decent splitter.
function displayState(s) {
  return s.state === 'waiting' && s.askedQuestion ? 'question' : s.state;
}

// ---- shared row data (consumed by the tree providers and the GUI webview) ----

async function sessionRowData(s, lastPrompt) {
  const branch = (await liveBranch(s.workCwd)) || s.gitBranch;
  let issueNum = null;
  let issueUrl = null;
  let pr = null;
  if (branch) {
    const url = await repoUrl(s.workCwd);
    issueNum = lib.issueNumberFromBranch(branch);
    if (url && issueNum) issueUrl = `${url}/issues/${issueNum}`;
    else issueNum = null;
    pr = await prForBranch(s.workCwd, branch);
  }
  // Derived names ("branch-ad") regenerate on every process restart. Identity order:
  // explicit session name > chat tab title (ai-title) > the user's last prompt.
  const explicitName = s.nameSource && s.nameSource !== 'derived' ? s.name : null;
  return {
    sessionId: s.sessionId,
    pid: s.pid,
    name: s.name,
    startedAt: s.startedAt,
    label: explicitName || s.title || lastPrompt || s.name,
    title: s.title,
    prompt: lastPrompt || null,
    display: s.display,
    word: STATE_WORD[s.display] || null,
    ageStr: s.stateTs ? lib.age(s.stateTs) : null,
    model: s.model ? s.model.replace(/^claude-/, '') : null,
    effort: s.effort,
    pct: s.pct,
    edited: s.editedFiles.length,
    editedNames: s.editedFiles.slice(-5).map((f) => path.basename(f)),
    branch,
    issueNum,
    issueUrl,
    pr,
    prLabel: lib.prLabel(pr),
    transcript: s.transcript,
    workCwd: s.workCwd,
  };
}

async function collectSessionRows() {
  const settings = lib.readClaudeSettings();
  const snaps = lib.listLiveSessions().map((r) => lib.sessionSnapshot(r, settings));
  for (const s of snaps) s.display = displayState(s);
  // Within actionable states, the longest-forgotten session floats to the top.
  snaps.sort((a, b) => {
    const rank = (STATE_RANK[a.display] ?? 9) - (STATE_RANK[b.display] ?? 9);
    if (rank) return rank;
    if (ACTIONABLE.has(a.display)) return (a.stateTs || Infinity) - (b.stateTs || Infinity);
    return a.startedAt - b.startedAt;
  });
  // history.jsonl is a fallback only: recent Claude Code versions stopped writing it,
  // so the primary source is the transcript's own last typed-user entry.
  const prompts = lib.lastPromptsBySession();
  return Promise.all(snaps.map((s) => sessionRowData(s, s.lastPrompt || prompts.get(s.sessionId))));
}

function attentionCount(rows) {
  return rows.filter((r) => ACTIONABLE.has(r.display)).length;
}

function badgeFor(n) {
  return n ? { value: n, tooltip: `${n} session(s) waiting on you` } : undefined;
}

const MYPR_STATUS_RANK = { bad: 0, pending: 1, good: 2 };

async function collectMyPrRows() {
  const repos = configuredRepos();
  if (!repos.length) return [];
  if (!myPrCache.rows || Date.now() - myPrCache.t > PR_TTL_MS) {
    const perRepo = await Promise.all(
      repos.map(async (repo) => {
        try {
          const { stdout } = await execFileP(
            GH,
            [
              'pr',
              'list',
              '--author',
              '@me',
              '--json',
              'number,title,url,reviewDecision,isDraft,statusCheckRollup,headRefName,updatedAt',
            ],
            { cwd: repo, maxBuffer: 10 * 1024 * 1024 } // statusCheckRollup is bulky on check-heavy repos
          );
          return JSON.parse(stdout).map((pr) => ({ ...lib.myPrRow(pr), repo }));
        } catch {
          return [];
        }
      })
    );
    const rows = perRepo.flat();
    // Red on top, then in-flight, then approved; newest activity first within a band.
    rows.sort(
      (a, b) =>
        MYPR_STATUS_RANK[a.status] - MYPR_STATUS_RANK[b.status] || (b.updatedAt || 0) - (a.updatedAt || 0)
    );
    myPrCache = { t: Date.now(), rows };
  }
  return myPrCache.rows;
}

async function collectWorktreeRows() {
  const repos = configuredRepos();
  if (!repos.length) return [];
  if (!worktreeCache.rows || Date.now() - worktreeCache.t > WORKTREE_TTL_MS) {
    const perRepo = await Promise.all(
      repos.map(async (repo) => {
        let wts = [];
        try {
          const { stdout } = await execFileP('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
          wts = lib.parseWorktrees(stdout).slice(1); // first stanza is the main checkout
        } catch {}
        return Promise.all(wts.map((wt) => worktreeRowData(wt, repo)));
      })
    );
    worktreeCache = { t: Date.now(), rows: perRepo.flat() };
  }
  return worktreeCache.rows;
}

async function worktreeRowData(wt, repo) {
  let dirty = null;
  try {
    const { stdout } = await execFileP('git', ['-C', wt.path, 'status', '--porcelain']);
    dirty = stdout.split('\n').filter(Boolean).length;
  } catch {}
  let lastCommitMs = null;
  try {
    const { stdout } = await execFileP('git', ['-C', wt.path, 'log', '-1', '--format=%ct']);
    lastCommitMs = Number(stdout.trim()) * 1000 || null;
  } catch {}
  const bits = [];
  if (wt.branch) bits.push(wt.branch);
  else if (wt.detached) bits.push('detached');
  if (dirty != null) bits.push(`${dirty} dirty`);
  if (lastCommitMs) bits.push(`last commit ${lib.relTime(lastCommitMs)}`);
  return { ...wt, repo, name: path.basename(wt.path), dirty, lastCommitMs, desc: bits.join(' · ') };
}

// Bulk stale-worktree cleanup: multi-select picker over every extra worktree, prunable
// pre-checked and stalest first. Chosen prunable rows go through `git worktree prune`
// (their directory is already gone); the rest through `git worktree remove`, which
// refuses dirty worktrees — those get one explicit modal confirm before --force.
async function cleanWorktrees() {
  worktreeCache.t = 0;
  const rows = await collectWorktreeRows();
  if (!rows.length) {
    vscode.window.showInformationMessage('panopticlaude: no extra worktrees to clean.');
    return;
  }
  const picks = rows
    .map((r) => ({
      label: r.name,
      description: r.desc + (r.prunable ? ' · PRUNABLE' : ''),
      picked: r.prunable,
      row: r,
    }))
    .sort((a, b) => b.row.prunable - a.row.prunable || (a.row.lastCommitMs || 0) - (b.row.lastCommitMs || 0));
  const chosen = await vscode.window.showQuickPick(picks, {
    canPickMany: true,
    title: 'Remove worktrees',
    placeHolder: 'Each selected worktree is git-worktree-removed; dirty ones ask before --force',
  });
  if (!chosen || !chosen.length) return;
  const prunable = chosen.filter((c) => c.row.prunable);
  for (const repo of new Set(prunable.map((c) => c.row.repo))) {
    try {
      await execFileP('git', ['-C', repo, 'worktree', 'prune']);
    } catch {}
  }
  const first = await removeWorktrees(chosen.filter((c) => !c.row.prunable), false);
  let removed = first.removed;
  if (first.refused.length) {
    const btn = await vscode.window.showWarningMessage(
      `${first.refused.length} worktree(s) refused removal (dirty or locked): ${first.refused.map((c) => c.label).join(', ')}. Force remove and discard their uncommitted changes?`,
      { modal: true },
      'Force Remove'
    );
    if (btn === 'Force Remove') {
      const second = await removeWorktrees(first.refused, true);
      removed += second.removed;
      for (const c of second.refused) vscode.window.showErrorMessage(`panopticlaude: ${c.label}: ${c.err.message}`);
    }
  }
  vscode.window.showInformationMessage(
    `panopticlaude: removed ${removed} worktree(s)${prunable.length ? `, pruned ${prunable.length}` : ''}.`
  );
  vscode.commands.executeCommand('panopticlaude.refresh');
}

// `git worktree remove` deletes the whole checkout directory — minutes each on a big
// monorepo — so the sequential loop runs under a visible, cancellable progress bar.
async function removeWorktrees(items, force) {
  let removed = 0;
  const refused = [];
  if (!items.length) return { removed, refused };
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: force ? 'Force-removing worktrees' : 'Removing worktrees',
      cancellable: true,
    },
    async (progress, token) => {
      for (let i = 0; i < items.length; i++) {
        if (token.isCancellationRequested) break;
        const c = items[i];
        progress.report({ message: `${c.label} (${i + 1}/${items.length})`, increment: 100 / items.length });
        const args = ['-C', c.row.repo, 'worktree', 'remove'];
        if (force) args.push('--force');
        try {
          await execFileP('git', [...args, c.row.path]);
          removed++;
        } catch (err) {
          refused.push({ ...c, err });
        }
      }
    }
  );
  return { removed, refused };
}

// --- assess-assumptions drafts: open today's file, post selected drafts via gh ---

// Every sweep bot comment opens with this line; its presence on an issue means the
// draft (or an equivalent) was already posted, so the issue is skipped.
const DUP_MARKER = 'Automated assumption check';

// Today's DRAFTS-YYYY-MM-DD.md, falling back to the newest one (sweep runs can be missed).
function resolveDraftFile(inboxDir) {
  const dir = expandHome(inboxDir);
  const today = path.join(dir, lib.draftFileName());
  if (fs.existsSync(today)) return today;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {}
  const latest = lib.latestDraftFile(names);
  return latest ? path.join(dir, latest) : null;
}

async function openTodayDraft(inboxDir) {
  const file = resolveDraftFile(inboxDir);
  if (!file) {
    vscode.window.showInformationMessage('panopticlaude: no DRAFTS-*.md files in ' + inboxDir);
    return;
  }
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

// Comments post as the ticket-automation GitHub App, never as the user. The mint
// script lives in the assess-assumptions skill (plugin cache when installed,
// ai-agent-tools checkout as fallback); newest copy wins.
function resolveMintScript() {
  const rel = ['skills', 'assess-assumptions', 'scripts', 'mint-bot-token.sh'];
  const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'ai-agent-tools', 'ticket-tools');
  const candidates = [];
  try {
    for (const hash of fs.readdirSync(cacheRoot)) candidates.push(path.join(cacheRoot, hash, ...rel));
  } catch {}
  candidates.push(path.join(os.homedir(), 'branch-workshop', 'ai-agent-tools', 'plugins', 'ticket-tools', ...rel));
  const found = candidates.filter((p) => fs.existsSync(p));
  if (!found.length) return null;
  return found.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
}

async function mintBotToken() {
  const script = resolveMintScript();
  if (!script) throw new Error('mint-bot-token.sh not found (plugin cache or ~/branch-workshop/ai-agent-tools)');
  // Extension host PATH lacks homebrew; the script needs doppler + jq.
  const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '') };
  const { stdout } = await execFileP('bash', [script], { env });
  const token = stdout.trim();
  if (!token.startsWith('ghs_')) throw new Error('unexpected mint output: ' + token.slice(0, 30));
  return token;
}

async function postDrafts(inboxDir, repo) {
  const file = resolveDraftFile(inboxDir);
  if (!file) {
    vscode.window.showErrorMessage('panopticlaude: no DRAFTS-*.md files in ' + inboxDir);
    return;
  }
  const fileName = path.basename(file);
  const { posted, drafts } = lib.parseDraftsFile(fs.readFileSync(file, 'utf8'));
  if (posted) {
    vscode.window.showErrorMessage(
      `panopticlaude: ${fileName} already has a POSTED banner — post leftovers from a Claude session instead.`
    );
    return;
  }
  if (!drafts.length) {
    vscode.window.showErrorMessage(`panopticlaude: no drafts found in ${fileName}.`);
    return;
  }
  const byN = new Map(drafts.map((d) => [d.n, d]));
  const input = await vscode.window.showInputBox({
    title: `Post drafts from ${fileName}`,
    prompt: `Draft numbers to post (available: ${drafts.map((d) => d.n).join(', ')})`,
    placeHolder: 'e.g. 2, 3, 5',
    validateInput: (v) => {
      const nums = v.split(/[\s,]+/).filter(Boolean);
      if (!nums.length) return 'Enter at least one draft number';
      const bad = nums.filter((s) => !byN.has(Number(s)));
      return bad.length ? `Not in ${fileName}: ${bad.join(', ')}` : null;
    },
  });
  if (!input) return;
  const chosen = [...new Set(input.split(/[\s,]+/).filter(Boolean).map(Number))].map((n) => byN.get(n));

  // Preflight: closed issues and issues already carrying a bot comment are skipped.
  const postable = [];
  const skipped = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking issues' },
    async (progress) => {
      for (const d of chosen) {
        progress.report({ message: `#${d.issue}`, increment: 100 / chosen.length });
        try {
          const { stdout } = await execFileP(
            GH,
            ['issue', 'view', String(d.issue), '-R', repo, '--json', 'state,comments'],
            { maxBuffer: 10 * 1024 * 1024 }
          );
          const info = JSON.parse(stdout);
          if (info.state !== 'OPEN') skipped.push({ ...d, reason: info.state.toLowerCase() });
          else if ((info.comments || []).some((c) => (c.body || '').includes(DUP_MARKER)))
            skipped.push({ ...d, reason: 'already has a bot comment' });
          else postable.push(d);
        } catch (err) {
          skipped.push({ ...d, reason: 'gh failed: ' + err.message.split('\n')[0] });
        }
      }
    }
  );
  if (!postable.length) {
    vscode.window.showWarningMessage(
      'panopticlaude: nothing to post. ' + skipped.map((s) => `#${s.issue}: ${s.reason}`).join('; ')
    );
    return;
  }
  const detail =
    postable.map((d) => `draft ${d.n} → #${d.issue} ${d.title}`).join('\n') +
    (skipped.length ? '\n\nSkipped:\n' + skipped.map((s) => `draft ${s.n} → #${s.issue}: ${s.reason}`).join('\n') : '');
  const btn = await vscode.window.showWarningMessage(
    `Post ${postable.length} comment(s) to ${repo} as ticket-automation[bot]?`,
    { modal: true, detail },
    'Post'
  );
  if (btn !== 'Post') return;

  let botToken;
  try {
    botToken = await mintBotToken();
  } catch (err) {
    vscode.window.showErrorMessage(
      'panopticlaude: could not mint ticket-automation bot token — nothing posted (will not post as you). ' +
        err.message.split('\n')[0]
    );
    return;
  }
  const botEnv = { ...process.env, GH_TOKEN: botToken };

  const postedOk = [];
  const failed = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Posting comments' },
    async (progress) => {
      for (const d of postable) {
        progress.report({ message: `#${d.issue}`, increment: 100 / postable.length });
        const tmp = path.join(os.tmpdir(), `panopticlaude-comment-${d.issue}.md`);
        try {
          fs.writeFileSync(tmp, lib.expandRelativeLinks(d.body, repo));
          const { stdout } = await execFileP(GH, ['issue', 'comment', String(d.issue), '-R', repo, '--body-file', tmp], {
            env: botEnv,
          });
          postedOk.push({ ...d, commentUrl: stdout.trim() });
        } catch (err) {
          failed.push({ ...d, err: err.message.split('\n')[0] });
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      }
    }
  );
  if (postedOk.length) {
    // Anything not posted in this run (unselected, skipped, or failed) lands in the
    // banner's NOT-posted list so a later session doesn't quietly re-post it.
    const notPosted = drafts.filter((d) => !postedOk.some((p) => p.n === d.n));
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, lib.postedBanner(postedOk, notPosted) + '\n\n' + text);
  }
  if (failed.length) {
    vscode.window.showErrorMessage(
      `panopticlaude: ${failed.length} post(s) failed: ` + failed.map((f) => `#${f.issue} (${f.err})`).join(', ')
    );
  }
  vscode.window.showInformationMessage(
    `panopticlaude: posted ${postedOk.length} comment(s) to ${repo}` +
      (skipped.length ? `, skipped ${skipped.length}` : '') +
      '.'
  );
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
}

async function cronRowData(c) {
  let schedule = null;
  try {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', c.label + '.plist');
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plist]);
    schedule = lib.scheduleFromPlist(JSON.parse(stdout));
  } catch {}
  let exit = null;
  try {
    const { stdout } = await execFileP('launchctl', ['print', `gui/${process.getuid()}/${c.label}`]);
    exit = lib.lastExitCodeFromLaunchctl(stdout);
  } catch {}
  const log = expandHome(c.log);
  let logMtime = null;
  try {
    logMtime = fs.statSync(log).mtimeMs;
  } catch {}
  const inbox = expandHome(c.inbox);
  const inboxSnap = inbox ? lib.snapshotInbox(inbox) : {};
  return {
    label: c.label,
    shortLabel: c.label.replace(/^com\.[^.]+\./, ''),
    schedule,
    exit,
    ranAgo: logMtime ? lib.relTime(logMtime) : null,
    nextIn: lib.untilTime(lib.nextRun(schedule)),
    overdue: lib.cronOverdue(schedule, logMtime),
    count: inbox ? lib.unseenCount(inboxSnap, lib.loadInboxSeen()[c.label]) : null,
    hasDrafts: !!lib.latestDraftFile(Object.keys(inboxSnap)),
    log: log || null,
    inbox: inbox || null,
    repo: c.repo || null,
  };
}

async function collectCronRows() {
  const crons = vscode.workspace.getConfiguration('panopticlaude').get('crons') || [];
  if (!crons.length) return [];
  if (!cronCache.rows || Date.now() - cronCache.t > CRON_TTL_MS) {
    cronCache = { t: Date.now(), rows: await Promise.all(crons.map(cronRowData)) };
  }
  return cronCache.rows;
}

// ---- tree rendering ----

function link(label, icon, target) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  const uri = typeof target === 'string' ? vscode.Uri.parse(target) : target;
  item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
  return item;
}

function revealLink(label, icon, fsPath) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command: 'revealFileInOS', title: 'Reveal', arguments: [vscode.Uri.file(fsPath)] };
  return item;
}

function cmdLink(label, icon, command, args) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label, arguments: args };
  return item;
}

class SessionsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() {
    this._em.fire(undefined);
  }
  getTreeItem(item) {
    return item;
  }
  async getChildren(parent) {
    if (parent) return parent.kids || [];
    const rows = await collectSessionRows();
    if (this.view) this.view.badge = badgeFor(attentionCount(rows));
    return rows.map((r) => this._item(r)); // empty -> viewsWelcome takes over
  }
  _item(r) {
    const trunc = (t) => (t && t.length > 46 ? t.slice(0, 45) + '…' : t);
    const item = new vscode.TreeItem(trunc(r.label), vscode.TreeItemCollapsibleState.Collapsed);
    item.id = r.sessionId;
    const bits = [];
    if (r.word) bits.push(r.word + (r.ageStr ? ' ' + r.ageStr : ''));
    if (r.model) bits.push(r.model);
    if (r.effort) bits.push(r.effort);
    if (r.pct != null) bits.push(r.pct >= 80 ? `${r.pct}% ⚠` : r.pct + '%');
    if (r.edited) bits.push(`✎${r.edited}`);
    if (r.branch) bits.push(r.branch);
    item.description = bits.join(' · ');
    const [icon, color] = STATE_ICON[r.display] || STATE_ICON.idle;
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const md = new vscode.MarkdownString('', true);
    if (r.title) md.appendMarkdown(`**${r.title}**\n\n`);
    if (r.prompt) md.appendMarkdown(`> ${r.prompt.slice(0, 300)}\n\n`);
    md.appendMarkdown(
      `$(pulse) ${r.display} · ${r.model || '?'} · ${r.effort || '?'} · ${r.pct != null ? r.pct + '% context' : ''}\n\n` +
        `$(folder) ${r.workCwd}\n\n` +
        `$(terminal) ${r.name} · pid ${r.pid} · started ${new Date(r.startedAt).toLocaleTimeString()}`
    );
    if (r.edited) md.appendMarkdown(`\n\n$(edit) ${r.edited} file(s): ${r.editedNames.join(', ')}`);
    item.tooltip = md;
    item.command = {
      command: 'panopticlaude.openSession',
      title: 'Open session',
      arguments: [r.sessionId, r.transcript],
    };
    const kids = [];
    if (r.issueUrl) kids.push(link(`Issue #${r.issueNum}`, 'issues', r.issueUrl));
    if (r.pr) kids.push(link(r.prLabel, 'git-pull-request', r.pr.url));
    kids.push(link('Open transcript', 'file-text', vscode.Uri.file(r.transcript)));
    item.kids = kids;
    return item;
  }
}

class CronsProvider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh(force) {
    if (force) cronCache.t = 0;
    this._em.fire(undefined);
  }
  getTreeItem(item) {
    return item;
  }
  async getChildren(parent) {
    if (parent) return parent.kids || [];
    const rows = await collectCronRows();
    return rows.map((r) => this._item(r)); // empty -> viewsWelcome takes over
  }
  _item(r) {
    const item = new vscode.TreeItem(r.shortLabel, vscode.TreeItemCollapsibleState.Collapsed);
    item.tooltip = r.label;
    const bits = [];
    if (r.schedule) bits.push('@' + r.schedule);
    if (r.exit != null && r.exit !== 'never-exited') bits.push('exit ' + r.exit);
    if (r.ranAgo) bits.push('ran ' + r.ranAgo);
    if (r.nextIn) bits.push('next in ' + r.nextIn);
    if (r.overdue) bits.push('MISSED TODAY');
    if (r.count) bits.push(r.count + ' to review');
    item.description = bits.join(' · ');
    const bad = r.exit != null && r.exit !== '0' && r.exit !== 'never-exited';
    const [icon, color] = bad
      ? ['error', 'charts.red']
      : r.overdue
        ? ['warning', 'charts.orange']
        : r.count
          ? ['mail', 'charts.blue']
          : ['check', 'charts.green'];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const kids = [];
    if (r.log) kids.push(link('Open log', 'output', vscode.Uri.file(r.log)));
    if (r.inbox) kids.push(revealLink(`Open inbox${r.count ? ` (${r.count} new)` : ''}`, 'inbox', r.inbox));
    if (r.hasDrafts) kids.push(cmdLink("Open today's draft", 'book', 'panopticlaude.openTodayDraft', [r.inbox]));
    if (r.hasDrafts && r.repo)
      kids.push(cmdLink('Post drafts…', 'comment-discussion', 'panopticlaude.postDrafts', [r.inbox, r.repo]));
    item.kids = kids;
    if (r.inbox) {
      item.contextValue = 'cron-inbox';
      item.cronLabel = r.label;
      item.cronInbox = r.inbox;
    }
    return item;
  }
}

// PRs and worktrees are flat lists; one provider parameterized by collector + item
// builder keeps the collector→tree+GUI pattern without two more near-identical classes.
class RowsProvider {
  constructor(collect, item) {
    this.collect = collect;
    this.item = item;
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() {
    this._em.fire(undefined);
  }
  getTreeItem(item) {
    return item;
  }
  async getChildren(parent) {
    if (parent) return [];
    return (await this.collect()).map(this.item); // empty -> viewsWelcome takes over
  }
}

function myPrItem(r) {
  const item = new vscode.TreeItem(r.title, vscode.TreeItemCollapsibleState.None);
  item.description = r.desc;
  item.tooltip = `${r.title}\n${r.desc}\n${r.url}`;
  const [icon, color] =
    r.status === 'bad'
      ? ['error', 'charts.red']
      : r.status === 'good'
        ? ['check', 'charts.green']
        : ['clock', 'charts.yellow'];
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  item.command = { command: 'vscode.open', title: 'Open PR', arguments: [vscode.Uri.parse(r.url)] };
  return item;
}

function worktreeItem(r) {
  const item = new vscode.TreeItem(r.name, vscode.TreeItemCollapsibleState.None);
  item.description = r.desc + (r.prunable ? ' · PRUNABLE' : '');
  item.tooltip = r.path;
  item.iconPath = r.prunable
    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'))
    : new vscode.ThemeIcon('git-branch');
  item.command = {
    command: 'vscode.openFolder',
    title: 'Open in new window',
    arguments: [vscode.Uri.file(r.path), { forceNewWindow: true }],
  };
  return item;
}

// ---- usage bars (Claude plan limits) ----

// OAuth token lives in the macOS Keychain (how Claude Code stores it on Mac); the
// plaintext ~/.claude/.credentials.json is the Linux fallback. Claude Code itself
// refreshes the token, so an expired one just means empty bars until it next runs.
async function claudeOauthToken() {
  let raw = null;
  try {
    ({ stdout: raw } = await execFileP('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']));
  } catch {
    try {
      raw = fs.readFileSync(path.join(lib.CLAUDE_DIR, '.credentials.json'), 'utf8');
    } catch {}
  }
  try {
    return JSON.parse(raw).claudeAiOauth.accessToken;
  } catch {
    return null;
  }
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function collectUsageRows() {
  if (usageCache.rows && Date.now() - usageCache.t < USAGE_TTL_MS) return usageCache.rows;
  let rows = [];
  try {
    const token = await claudeOauthToken();
    if (token) {
      const json = await getJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
      });
      rows = lib.usageRows(json);
    }
  } catch {}
  usageCache = { t: Date.now(), rows };
  return rows;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Native-mode usage view: no interaction needed, so the HTML is just re-set on each
// refresh — no script, no message passing.
function usageHtml(rows) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const bars = rows
    .map(
      (r) => `
  <div class="row"><span>${escapeHtml(r.label)}</span><span class="pct">${r.pct}%</span></div>
  <div class="bar"><div class="fill${r.hot ? ' hot' : ''}" style="width:${Math.max(2, Math.min(100, r.pct))}%"></div></div>
  ${r.resets ? `<div class="resets">${escapeHtml(r.resets)}</div>` : ''}`
    )
    .join('');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: transparent; margin: 0; padding: 2px 12px 8px; }
.row { display: flex; justify-content: space-between; margin-top: 8px; }
.pct { color: var(--vscode-descriptionForeground); }
.bar { height: 4px; border-radius: 2px; margin-top: 4px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); overflow: hidden; }
.fill { height: 100%; border-radius: 2px; background: var(--vscode-progressBar-background); }
.fill.hot { background: var(--vscode-charts-red); }
.resets { margin-top: 3px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.empty { color: var(--vscode-descriptionForeground); margin-top: 8px; }
.gui-link { display: block; margin-top: 10px; padding: 0; border: none; background: none; font: inherit; font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; }
</style></head><body>
${rows.length ? bars : '<div class="empty">usage unavailable</div>'}
<button class="gui-link" id="gui">switch to GUI view</button>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('gui').addEventListener('click', () => vscode.postMessage({ type: 'show-gui' }));
</script></body></html>`;
}

// This view only exists in tree mode, so it doubles as the always-visible way back to
// GUI mode — the view/title icons on stacked tree views are hover-only and easy to miss.
class UsageViewProvider {
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'show-gui') vscode.commands.executeCommand('panopticlaude.showGui');
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
    this.refresh();
  }
  async refresh() {
    if (!this.view || !this.view.visible) return;
    this.view.webview.html = usageHtml(await collectUsageRows());
  }
}

// ---- GUI webview ----

class GuiViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
  }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'gui.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'gui.js'));
    webview.html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    webview.onDidReceiveMessage((msg) => this._onMessage(msg));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
    });
  }
  async refresh() {
    if (!this.view) return;
    const [sessions, prs, worktrees, crons, usage] = await Promise.all([
      collectSessionRows(),
      collectMyPrRows(),
      collectWorktreeRows(),
      collectCronRows(),
      collectUsageRows(),
    ]);
    this.view.badge = badgeFor(attentionCount(sessions)); // badge stays sessions-only
    if (this.view.visible) this.view.webview.postMessage({ type: 'data', sessions, prs, worktrees, crons, usage });
  }
  async _onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.refresh();
        break;
      case 'open-session':
        vscode.commands.executeCommand('panopticlaude.openSession', msg.sessionId, msg.transcript);
        break;
      case 'open-url':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'open-file':
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
        break;
      case 'reveal':
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        break;
      case 'open-folder':
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), { forceNewWindow: true });
        break;
      case 'clean-worktrees':
        vscode.commands.executeCommand('panopticlaude.cleanWorktrees');
        break;
      case 'mark-reviewed':
        lib.saveInboxSeen(msg.label, lib.snapshotInbox(msg.inbox));
        cronCache.t = 0;
        this.refresh();
        break;
      case 'open-today-draft':
        vscode.commands.executeCommand('panopticlaude.openTodayDraft', msg.inbox);
        break;
      case 'post-drafts':
        vscode.commands.executeCommand('panopticlaude.postDrafts', msg.inbox, msg.repo);
        break;
    }
  }
}

// ---- hooks install ----

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest', 'SessionEnd'];

function installHooks(context) {
  try {
    const script = path.join(context.extensionPath, 'hooks', 'panopticlaude-hook.sh');
    fs.chmodSync(script, 0o755);
    const settingsFile = path.join(lib.CLAUDE_DIR, 'settings.json');
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const settings = JSON.parse(raw);
    fs.writeFileSync(settingsFile + '.pre-panopticlaude.bak', raw);
    settings.hooks = settings.hooks || {};
    let added = 0;
    for (const evt of HOOK_EVENTS) {
      const groups = (settings.hooks[evt] = settings.hooks[evt] || []);
      const exists = groups.some((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('panopticlaude-hook'))
      );
      if (!exists) {
        groups.push({ hooks: [{ type: 'command', command: `"${script}"` }] });
        added++;
      }
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    vscode.window.showInformationMessage(
      added
        ? `panopticlaude: hooks added for ${added} event(s). New Claude Code sessions will report state; running ones keep the mtime heuristic until restarted.`
        : 'panopticlaude: hooks already installed.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(`panopticlaude: hook install failed: ${err.message}`);
  }
}

function activate(context) {
  fs.mkdirSync(lib.STATE_DIR, { recursive: true });
  const sessions = new SessionsProvider();
  const myPrs = new RowsProvider(collectMyPrRows, myPrItem);
  const worktrees = new RowsProvider(collectWorktreeRows, worktreeItem);
  const crons = new CronsProvider();
  const usage = new UsageViewProvider();
  const gui = new GuiViewProvider(context.extensionUri);

  const guiMode = context.globalState.get('guiMode', false);
  vscode.commands.executeCommand('setContext', 'panopticlaude.gui', guiMode);
  const setMode = (on) => {
    context.globalState.update('guiMode', on);
    vscode.commands.executeCommand('setContext', 'panopticlaude.gui', on);
  };

  // createTreeView (not registerTreeDataProvider) so the sessions view can set an
  // activity-bar badge with the waiting-on-you count.
  const sessionsView = vscode.window.createTreeView('panopticlaude.sessions', {
    treeDataProvider: sessions,
  });
  sessions.view = sessionsView;
  context.subscriptions.push(
    sessionsView,
    vscode.window.registerTreeDataProvider('panopticlaude.prs', myPrs),
    vscode.window.registerTreeDataProvider('panopticlaude.worktrees', worktrees),
    vscode.window.registerTreeDataProvider('panopticlaude.crons', crons),
    vscode.window.registerWebviewViewProvider('panopticlaude.usage', usage),
    vscode.window.registerWebviewViewProvider('panopticlaude.gui', gui),
    vscode.commands.registerCommand('panopticlaude.refresh', () => {
      myPrCache.t = 0;
      worktreeCache.t = 0;
      usageCache.t = 0;
      sessions.refresh();
      myPrs.refresh();
      worktrees.refresh();
      crons.refresh(true);
      usage.refresh();
      gui.refresh();
    }),
    vscode.commands.registerCommand('panopticlaude.showGui', () => setMode(true)),
    vscode.commands.registerCommand('panopticlaude.showTree', () => setMode(false)),
    vscode.commands.registerCommand('panopticlaude.installHooks', () => installHooks(context)),
    vscode.commands.registerCommand('panopticlaude.cleanWorktrees', cleanWorktrees),
    vscode.commands.registerCommand('panopticlaude.openTodayDraft', openTodayDraft),
    vscode.commands.registerCommand('panopticlaude.postDrafts', postDrafts),
    vscode.commands.registerCommand('panopticlaude.markInboxReviewed', (item) => {
      if (!item || !item.cronInbox) return;
      lib.saveInboxSeen(item.cronLabel, lib.snapshotInbox(item.cronInbox));
      crons.refresh(true);
      gui.refresh();
    }),
    // claude-vscode.editor.open(sessionId) is the Claude Code extension's own internal
    // command for opening a conversation tab — undocumented, so fall back to the raw
    // transcript if it's missing or renamed.
    vscode.commands.registerCommand('panopticlaude.openSession', async (sessionId, transcript) => {
      try {
        await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
      } catch {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(transcript));
      }
    })
  );
  const sessionTimer = setInterval(() => {
    sessions.refresh();
    gui.refresh();
  }, 5_000);
  // One slow timer for everything spawn-backed; the caches gate the actual gh/git runs.
  const cronTimer = setInterval(() => {
    myPrs.refresh();
    worktrees.refresh();
    crons.refresh();
    usage.refresh();
  }, 60_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(sessionTimer);
      clearInterval(cronTimer);
    },
  });
  try {
    const watcher = fs.watch(lib.STATE_DIR, () => {
      sessions.refresh();
      gui.refresh();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {}
}

function deactivate() {}

module.exports = { activate, deactivate };
