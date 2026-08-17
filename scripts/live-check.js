// Prints the rows the Sessions tree would render, from real local data.
// Run: node scripts/live-check.js
const lib = require('../lib');

const settings = lib.readClaudeSettings();
const snaps = lib.listLiveSessions().map((r) => lib.sessionSnapshot(r, settings));
if (!snaps.length) {
  console.log('no live sessions');
} else {
  for (const s of snaps) {
    console.log(
      `${s.name.padEnd(12)} ${s.model} · ${s.effort} · ${s.pct}% · ${s.state} · ${s.gitBranch} (pid ${s.pid}, issue ${lib.issueNumberFromBranch(s.gitBranch)})`
    );
  }
}
