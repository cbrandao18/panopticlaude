// Prints the rows the Sessions tree would render, from real local data.
// Run: node scripts/live-check.js
const lib = require('../lib');

const { execFileSync } = require('child_process');

const settings = lib.readClaudeSettings();
const prompts = lib.lastPromptsBySession();
const snaps = lib.listLiveSessions().map((r) => lib.sessionSnapshot(r, settings));
if (!snaps.length) {
  console.log('no live sessions');
} else {
  for (const s of snaps) {
    let branch = s.gitBranch;
    try {
      branch = execFileSync('git', ['-C', s.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || branch;
    } catch {}
    const prompt = s.lastPrompt || prompts.get(s.sessionId);
    const label = prompt ? prompt.slice(0, 45) : s.name;
    console.log(
      `[${label}]  ${s.model} · ${s.effort} · ${s.pct}% · ${s.state} · ${branch} (pid ${s.pid}, issue ${lib.issueNumberFromBranch(branch)})`
    );
  }
}
