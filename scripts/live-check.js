// Prints the rows the Sessions/My PRs/Worktrees/Crons views would render, from real
// local data. Run: node scripts/live-check.js
const lib = require('../lib');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';
const expandHome = (p) => p && p.replace(/^~(?=$|\/)/, os.homedir());

// Same source the extension reads via vscode.workspace: the user settings file.
function vscodeSetting(key, fallback) {
  try {
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))[key];
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

const settings = lib.readClaudeSettings();
const prompts = lib.lastPromptsBySession();
const snaps = lib.listLiveSessions().map((r) => lib.sessionSnapshot(r, settings));
if (!snaps.length) {
  console.log('no live sessions');
} else {
  for (const s of snaps) {
    let branch = s.gitBranch;
    try {
      branch = execFileSync('git', ['-C', s.workCwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || branch;
    } catch {}
    const prompt = s.lastPrompt || prompts.get(s.sessionId);
    const label = s.title || (prompt ? prompt.slice(0, 45) : s.name);
    console.log(
      `[${label}]  ${s.model} · ${s.effort} · ${s.pct}% · ${s.state} · ${branch} (pid ${s.pid}, issue ${lib.issueNumberFromBranch(branch)})`
    );
  }
}

const repos = vscodeSetting('panopticlaude.repos', ['~/branch']).map(expandHome);

console.log('\n-- My PRs --');
for (const repo of repos) {
  let prs = [];
  try {
    prs = JSON.parse(
      execFileSync(
        GH,
        ['pr', 'list', '--author', '@me', '--json', 'number,title,url,reviewDecision,isDraft,statusCheckRollup,headRefName,updatedAt'],
        { cwd: repo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      )
    );
  } catch (e) {
    console.log(`${repo}: gh failed: ${e.message.split('\n')[0]}`);
  }
  for (const pr of prs) {
    const r = lib.myPrRow(pr);
    console.log(`[${r.status}] ${r.title}  (${r.desc})`);
  }
}

console.log('\n-- Worktrees --');
for (const repo of repos) {
  let wts = [];
  try {
    wts = lib.parseWorktrees(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).slice(1);
  } catch (e) {
    console.log(`${repo}: git failed: ${e.message.split('\n')[0]}`);
  }
  for (const wt of wts) {
    let dirty = '?';
    let last = '?';
    // A prunable worktree's gitdir is gone: git fails loudly, and that's fine.
    const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    try {
      dirty = execFileSync('git', ['-C', wt.path, 'status', '--porcelain'], quiet).split('\n').filter(Boolean).length;
      last = lib.relTime(Number(execFileSync('git', ['-C', wt.path, 'log', '-1', '--format=%ct'], quiet).trim()) * 1000);
    } catch {}
    console.log(
      `${path.basename(wt.path)}  ${wt.branch || 'detached'} · ${dirty} dirty · last commit ${last}${wt.prunable ? ' · PRUNABLE' : ''}`
    );
  }
}

console.log('\n-- Cron next runs --');
for (const c of vscodeSetting('panopticlaude.crons', [])) {
  let schedule = null;
  try {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', c.label + '.plist');
    schedule = lib.scheduleFromPlist(JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })));
  } catch {}
  console.log(`${c.label}  @${schedule} · next in ${lib.untilTime(lib.nextRun(schedule))}`);
}
