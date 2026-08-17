// panopticlaude: VSCode glue. All parsing lives in lib.js; this file renders trees,
// resolves issue/PR links (git/gh spawns, cached), and installs the Claude Code hooks.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(require('child_process').execFile);
const lib = require('./lib');

const PR_TTL_MS = 5 * 60 * 1000;
const CRON_TTL_MS = 60 * 1000;
const remoteByCwd = new Map(); // cwd -> repo URL or null
const prByKey = new Map(); // `${cwd}|${branch}` -> { t, pr }
let cronCache = { t: 0, rows: null };

const BRANCH_TTL_MS = 30 * 1000;
const branchByCwd = new Map(); // cwd -> { t, v }

// Live checkout of the session's cwd. The transcript's per-entry gitBranch reflects
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

// The extension host's PATH lacks homebrew, so `gh` must be resolved absolutely.
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';

async function prForBranch(cwd, branch) {
  const key = cwd + '|' + branch;
  const hit = prByKey.get(key);
  if (hit && Date.now() - hit.t < PR_TTL_MS) return hit.pr;
  let pr = null;
  try {
    const { stdout } = await execFileP(
      GH,
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state', '--limit', '1'],
      { cwd }
    );
    const arr = JSON.parse(stdout);
    if (arr.length) pr = arr[0];
  } catch {}
  prByKey.set(key, { t: Date.now(), pr });
  return pr;
}

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
    const settings = lib.readClaudeSettings();
    const snaps = lib.listLiveSessions().map((r) => lib.sessionSnapshot(r, settings));
    for (const s of snaps) s.display = displayState(s);
    const attention = snaps.filter((s) => ACTIONABLE.has(s.display)).length;
    if (this.view) {
      this.view.badge = attention
        ? { value: attention, tooltip: `${attention} session(s) waiting on you` }
        : undefined;
    }
    if (!snaps.length) return []; // viewsWelcome takes over
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
    return Promise.all(snaps.map((s) => this._item(s, s.lastPrompt || prompts.get(s.sessionId))));
  }
  async _item(s, lastPrompt) {
    // Derived names ("branch-ad") regenerate on every process restart. Identity order:
    // explicit session name > chat tab title (ai-title) > the user's last prompt.
    const explicitName = s.nameSource && s.nameSource !== 'derived' ? s.name : null;
    const trunc = (t) => (t && t.length > 46 ? t.slice(0, 45) + '…' : t);
    const label = explicitName || trunc(s.title) || trunc(lastPrompt) || s.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = s.sessionId;
    const branch = (await liveBranch(s.workCwd)) || s.gitBranch;
    const bits = [];
    if (STATE_WORD[s.display]) {
      const waitAge = s.stateTs ? ' ' + lib.age(s.stateTs) : '';
      bits.push(STATE_WORD[s.display] + waitAge);
    }
    if (s.model) bits.push(s.model.replace(/^claude-/, ''));
    if (s.effort) bits.push(s.effort);
    if (s.pct != null) bits.push(s.pct >= 80 ? `${s.pct}% ⚠` : s.pct + '%');
    if (s.editedFiles.length) bits.push(`✎${s.editedFiles.length}`);
    if (branch) bits.push(branch);
    item.description = bits.join(' · ');
    const [icon, color] = STATE_ICON[s.display] || STATE_ICON.idle;
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const md = new vscode.MarkdownString('', true);
    if (s.title) md.appendMarkdown(`**${s.title}**\n\n`);
    if (lastPrompt) md.appendMarkdown(`> ${lastPrompt.slice(0, 300)}\n\n`);
    md.appendMarkdown(
      `$(pulse) ${s.display} · ${s.model || '?'} · ${s.effort || '?'} · ${s.pct != null ? s.pct + '% context' : ''}\n\n` +
        `$(folder) ${s.workCwd}\n\n` +
        `$(terminal) ${s.name} · pid ${s.pid} · started ${new Date(s.startedAt).toLocaleTimeString()}`
    );
    if (s.editedFiles.length) {
      const names = s.editedFiles.slice(-5).map((f) => path.basename(f));
      md.appendMarkdown(`\n\n$(edit) ${s.editedFiles.length} file(s): ${names.join(', ')}`);
    }
    item.tooltip = md;
    item.command = {
      command: 'panopticlaude.openSession',
      title: 'Open session',
      arguments: [s.sessionId, s.transcript],
    };

    const kids = [];
    if (branch) {
      const url = await repoUrl(s.workCwd);
      const issue = lib.issueNumberFromBranch(branch);
      if (url && issue) kids.push(link(`Issue #${issue}`, 'issues', `${url}/issues/${issue}`));
      const pr = await prForBranch(s.workCwd, branch);
      if (pr) {
        const suffix = pr.state && pr.state !== 'OPEN' ? ` (${pr.state.toLowerCase()})` : '';
        kids.push(link(`PR #${pr.number}${suffix}`, 'git-pull-request', pr.url));
      }
    }
    kids.push(link('Open transcript', 'file-text', vscode.Uri.file(s.transcript)));
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
    const crons = vscode.workspace.getConfiguration('panopticlaude').get('crons') || [];
    if (!crons.length) return []; // viewsWelcome takes over
    if (!cronCache.rows || Date.now() - cronCache.t > CRON_TTL_MS) {
      cronCache = { t: Date.now(), rows: await Promise.all(crons.map((c) => this._row(c))) };
    }
    return cronCache.rows;
  }
  async _row(c) {
    const home = os.homedir();
    const expand = (p) => p && p.replace(/^~(?=$|\/)/, home);
    let schedule = null;
    try {
      const plist = path.join(home, 'Library', 'LaunchAgents', c.label + '.plist');
      const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plist]);
      schedule = lib.scheduleFromPlist(JSON.parse(stdout));
    } catch {}
    let exit = null;
    try {
      const { stdout } = await execFileP('launchctl', ['print', `gui/${process.getuid()}/${c.label}`]);
      exit = lib.lastExitCodeFromLaunchctl(stdout);
    } catch {}
    const log = expand(c.log);
    let logMtime = null;
    try {
      logMtime = fs.statSync(log).mtimeMs;
    } catch {}
    const overdue = lib.cronOverdue(schedule, logMtime);
    const inbox = expand(c.inbox);
    const count = inbox ? lib.unseenCount(lib.snapshotInbox(inbox), lib.loadInboxSeen()[c.label]) : null;

    const item = new vscode.TreeItem(
      c.label.replace(/^com\.[^.]+\./, ''),
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.tooltip = c.label;
    const bits = [];
    if (schedule) bits.push('@' + schedule);
    if (exit != null && exit !== 'never-exited') bits.push('exit ' + exit);
    if (logMtime) bits.push('ran ' + lib.relTime(logMtime));
    if (overdue) bits.push('MISSED TODAY');
    if (count) bits.push(count + ' to review');
    item.description = bits.join(' · ');
    const bad = exit != null && exit !== '0' && exit !== 'never-exited';
    const [icon, color] = bad
      ? ['error', 'charts.red']
      : overdue
        ? ['warning', 'charts.orange']
        : count
          ? ['mail', 'charts.blue']
          : ['check', 'charts.green'];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));

    const kids = [];
    if (log) kids.push(link('Open log', 'output', vscode.Uri.file(log)));
    if (inbox) kids.push(revealLink(`Open inbox${count ? ` (${count} new)` : ''}`, 'inbox', inbox));
    item.kids = kids;
    if (inbox) {
      item.contextValue = 'cron-inbox';
      item.cronLabel = c.label;
      item.cronInbox = inbox;
    }
    return item;
  }
}

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
  const crons = new CronsProvider();
  // createTreeView (not registerTreeDataProvider) so the sessions view can set an
  // activity-bar badge with the waiting-on-you count.
  const sessionsView = vscode.window.createTreeView('panopticlaude.sessions', {
    treeDataProvider: sessions,
  });
  sessions.view = sessionsView;
  context.subscriptions.push(
    sessionsView,
    vscode.window.registerTreeDataProvider('panopticlaude.crons', crons),
    vscode.commands.registerCommand('panopticlaude.refresh', () => {
      sessions.refresh();
      crons.refresh(true);
    }),
    vscode.commands.registerCommand('panopticlaude.installHooks', () => installHooks(context)),
    vscode.commands.registerCommand('panopticlaude.markInboxReviewed', (item) => {
      if (!item || !item.cronInbox) return;
      lib.saveInboxSeen(item.cronLabel, lib.snapshotInbox(item.cronInbox));
      crons.refresh(true);
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
  const sessionTimer = setInterval(() => sessions.refresh(), 5_000);
  const cronTimer = setInterval(() => crons.refresh(), 60_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(sessionTimer);
      clearInterval(cronTimer);
    },
  });
  try {
    const watcher = fs.watch(lib.STATE_DIR, () => sessions.refresh());
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {}
}

function deactivate() {}

module.exports = { activate, deactivate };
