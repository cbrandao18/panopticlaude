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
  running: ['play-circle', 'charts.green'],
  waiting: ['bell-dot', 'charts.yellow'],
  idle: ['circle-outline', 'disabledForeground'],
};
const STATE_RANK = { 'needs-you': 0, running: 1, waiting: 2, idle: 3 };

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
    if (!snaps.length) return [new vscode.TreeItem('no live sessions')];
    snaps.sort(
      (a, b) =>
        (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || a.startedAt - b.startedAt
    );
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
    if (s.model) bits.push(s.model.replace(/^claude-/, ''));
    if (s.effort) bits.push(s.effort);
    if (s.pct != null) bits.push(s.pct + '%');
    bits.push(s.state);
    if (branch) bits.push(branch);
    item.description = bits.join(' · ');
    const [icon, color] = STATE_ICON[s.state] || STATE_ICON.idle;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.tooltip = `${s.title || ''}\n${lastPrompt ? '❝ ' + lastPrompt : ''}\n\n${s.name} · ${s.workCwd}\npid ${s.pid} · started ${new Date(s.startedAt).toLocaleTimeString()}`.trim();
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
    if (!crons.length) return [new vscode.TreeItem('no crons configured (setting: panopticlaude.crons)')];
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
    const count = inbox ? lib.inboxCount(inbox) : null;

    const item = new vscode.TreeItem(
      c.label.replace(/^com\.[^.]+\./, ''),
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.tooltip = c.label;
    const bits = [];
    if (schedule) bits.push('@' + schedule);
    if (exit != null && exit !== 'never-exited') bits.push('exit ' + exit);
    if (logMtime)
      bits.push(
        'ran ' +
          new Date(logMtime).toLocaleString([], {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
      );
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
    if (inbox) kids.push(revealLink(`Open inbox${count ? ` (${count})` : ''}`, 'inbox', inbox));
    item.kids = kids;
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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('panopticlaude.sessions', sessions),
    vscode.window.registerTreeDataProvider('panopticlaude.crons', crons),
    vscode.commands.registerCommand('panopticlaude.refresh', () => {
      sessions.refresh();
      crons.refresh(true);
    }),
    vscode.commands.registerCommand('panopticlaude.installHooks', () => installHooks(context)),
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
