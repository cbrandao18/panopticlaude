// Plans in process-updates/docs: each doc's front matter (status, next, replaced_by) and title.
// Upcoming plans are the ones not done or superseded. Read-only, Mac-local files.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DOCS = path.join(os.homedir(), 'branch-agents/projects/process-updates/docs');
const SUBDIRS = ['', 'superpowers/specs', 'superpowers/plans'];
const ORDER = ['building', 'approved', 'draft', 'on-hold'];
const STALE_MS = 7 * 86400000;

function parseDoc(text) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = {};
  for (const line of (fm ? fm[1] : '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  const title = /^# (.+)$/m.exec(text)?.[1].trim() || null;
  return { status: meta.status || null, next: meta.next || null, replacedBy: meta.replaced_by || null, title };
}

async function readPlans(dir = DOCS, now = Date.now()) {
  const docs = [];
  for (const sub of SUBDIRS) {
    const names = await fs.readdir(path.join(dir, sub)).catch((e) => (sub && e.code === 'ENOENT' ? [] : Promise.reject(e)));
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      const file = path.join(sub, name);
      const full = path.join(dir, file);
      const [text, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      docs.push({ file, kind: sub ? path.basename(sub).replace(/s$/, '') : 'doc', updatedAt: stat.mtimeMs, ...parseDoc(text) });
    }
  }
  return summarize(docs, now);
}

function summarize(docs, now = Date.now()) {
  const upcoming = docs
    .filter((d) => ORDER.includes(d.status))
    .map((d) => ({ ...d, stale: d.status !== 'on-hold' && now - d.updatedAt > STALE_MS }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt);
  const counts = {};
  for (const d of docs) counts[d.status || 'missing'] = (counts[d.status || 'missing'] || 0) + 1;
  // A doc with no status, or an upcoming one with no next step, breaks the docs convention in AGENTS.md.
  const unlabeled = docs.filter((d) => !d.status || (ORDER.includes(d.status) && !d.next)).map((d) => d.file).sort();
  return { upcoming, counts, unlabeled, dir: DOCS };
}

module.exports = { readPlans, parseDoc, summarize, ORDER };
