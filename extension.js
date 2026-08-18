// panopticlaude: VSCode glue. All parsing lives in lib.js; this file collects row data
// (git/gh spawns, cached), renders it as either native trees or the webview GUI (the
// user toggles between them; the context key panopticlaude.gui picks which views show),
// and installs the Claude Code hooks.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(require('child_process').execFile);
const lib = require('./lib');

const PR_TTL_MS = 5 * 60 * 1000;
const CRON_TTL_MS = 60 * 1000;
const BRANCH_TTL_MS = 30 * 1000;
const remoteByCwd = new Map(); // cwd -> repo URL or null
const prByKey = new Map(); // `${cwd}|${branch}` -> { t, pr }
const branchByCwd = new Map(); // cwd -> { t, v }
let cronCache = { t: 0, rows: null };

// The extension host's PATH lacks homebrew, so `gh` must be resolved absolutely.
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';

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
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state', '--limit', '1'],
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

async function cronRowData(c) {
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
  const inbox = expand(c.inbox);
  return {
    label: c.label,
    shortLabel: c.label.replace(/^com\.[^.]+\./, ''),
    schedule,
    exit,
    ranAgo: logMtime ? lib.relTime(logMtime) : null,
    overdue: lib.cronOverdue(schedule, logMtime),
    count: inbox ? lib.unseenCount(lib.snapshotInbox(inbox), lib.loadInboxSeen()[c.label]) : null,
    log: log || null,
    inbox: inbox || null,
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
    if (r.pr) {
      const suffix = r.pr.state && r.pr.state !== 'OPEN' ? ` (${r.pr.state.toLowerCase()})` : '';
      kids.push(link(`PR #${r.pr.number}${suffix}`, 'git-pull-request', r.pr.url));
    }
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
    item.kids = kids;
    if (r.inbox) {
      item.contextValue = 'cron-inbox';
      item.cronLabel = r.label;
      item.cronInbox = r.inbox;
    }
    return item;
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
    const [sessions, crons] = await Promise.all([collectSessionRows(), collectCronRows()]);
    this.view.badge = badgeFor(attentionCount(sessions));
    if (this.view.visible) this.view.webview.postMessage({ type: 'data', sessions, crons });
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
      case 'mark-reviewed':
        lib.saveInboxSeen(msg.label, lib.snapshotInbox(msg.inbox));
        cronCache.t = 0;
        this.refresh();
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
  const crons = new CronsProvider();
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
    vscode.window.registerTreeDataProvider('panopticlaude.crons', crons),
    vscode.window.registerWebviewViewProvider('panopticlaude.gui', gui),
    vscode.commands.registerCommand('panopticlaude.refresh', () => {
      sessions.refresh();
      crons.refresh(true);
      gui.refresh();
    }),
    vscode.commands.registerCommand('panopticlaude.showGui', () => setMode(true)),
    vscode.commands.registerCommand('panopticlaude.showTree', () => setMode(false)),
    vscode.commands.registerCommand('panopticlaude.installHooks', () => installHooks(context)),
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
  const cronTimer = setInterval(() => crons.refresh(), 60_000);
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
