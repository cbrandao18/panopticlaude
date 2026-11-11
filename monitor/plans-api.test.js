const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDoc, readPlans } = require('./plans-api');

test('parseDoc reads front matter and the first heading', () => {
  assert.deepStrictEqual(parseDoc('---\nstatus: draft\nnext: Approve it\n---\n\n# Easy-win loop\n\nBody'),
    { status: 'draft', next: 'Approve it', replacedBy: null, title: 'Easy-win loop' });
  assert.deepStrictEqual(parseDoc('# Old doc\n'), { status: null, next: null, replacedBy: null, title: 'Old doc' });
});

test('readPlans lists upcoming plans by status, flags stale and unlabeled docs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  fs.mkdirSync(path.join(dir, 'superpowers/plans'), { recursive: true });
  const write = (file, text, daysOld) => {
    fs.writeFileSync(path.join(dir, file), text);
    const t = new Date(Date.now() - daysOld * 86400000);
    fs.utimesSync(path.join(dir, file), t, t);
  };
  write('a.md', '---\nstatus: draft\nnext: Approve\n---\n# A\n', 1);
  write('b.md', '---\nstatus: building\nnext: Ship\n---\n# B\n', 10);
  write('c.md', '---\nstatus: done\n---\n# C\n', 30);
  write('d.md', '# D, no front matter\n', 2);
  write('superpowers/plans/e.md', '---\nstatus: approved\n---\n# E\n', 0);
  const r = await readPlans(dir);
  assert.deepStrictEqual(r.upcoming.map((p) => [p.file, p.stale]), [['b.md', true], ['superpowers/plans/e.md', false], ['a.md', false]]);
  assert.strictEqual(r.upcoming[1].kind, 'plan');
  assert.deepStrictEqual(r.counts, { draft: 1, building: 1, done: 1, missing: 1, approved: 1 });
  assert.deepStrictEqual(r.unlabeled, ['d.md', 'superpowers/plans/e.md']);
  fs.rmSync(dir, { recursive: true });
});
