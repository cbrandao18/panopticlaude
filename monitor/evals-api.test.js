const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEvals } = require('./evals-api');

const trial = (run, config, task, rep, pass, extra = {}) =>
  JSON.stringify({ suite: 's', run, at: `2026-11-1${run.slice(-1)}T12:00:00+00:00`, config, model: `claude-${config}`, skill_version: 'abc1234',
    task, rep, pass, got: {}, want: {}, cost: 0.01, secs: 5, err: null, ...extra });

test('readEvals builds the latest grid, marks changes since the previous run and totals each configuration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  fs.mkdirSync(path.join(dir, 'results'));
  fs.mkdirSync(path.join(dir, 'benchmarks/s'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'benchmarks/s/suite.yaml'), 'name: "Example suite"\n');
  fs.writeFileSync(path.join(dir, 'results/s.jsonl'), [
    trial('run1', 'opus', 't1', 0, true), trial('run1', 'opus', 't2', 0, false),
    trial('run2', 'opus', 't1', 0, false), trial('run2', 'opus', 't1', 1, true),
    trial('run2', 'opus', 't2', 0, true), trial('run2', 'opus', 't2', 1, true),
    trial('run2', 'haiku', 't1', 0, false, { err: 'timeout', cost: null }),
    'not json', ''
  ].join('\n'));
  const [s] = (await readEvals(dir)).suites;
  assert.strictEqual(s.title, 'Example suite');
  assert.strictEqual(s.run, 'run2');
  assert.strictEqual(s.unreadable, 1);
  assert.deepStrictEqual(s.configs, ['opus', 'haiku']);
  assert.deepStrictEqual(s.tasks, ['t1', 't2']);
  assert.strictEqual(s.cells.t1.opus.change, 'regressed');
  assert.strictEqual(s.cells.t2.opus.change, 'improved');
  assert.deepStrictEqual(s.cells.t1.opus.previous, { run: 'run1', passed: 1, total: 1 });
  assert.strictEqual(s.cells.t1.haiku.previous, undefined);
  assert.strictEqual(s.cells.t2.haiku, undefined);
  const [opus, haiku] = s.totals;
  assert.deepStrictEqual([opus.passed, opus.total, opus.errors, opus.cost, opus.skillVersions], [3, 4, 0, 0.04, ['abc1234']]);
  assert.deepStrictEqual(opus.trend, [{ run: 'run1', passed: 1, total: 2 }, { run: 'run2', passed: 3, total: 4 }]);
  assert.deepStrictEqual([haiku.errors, haiku.cost], [1, 0]);
  fs.rmSync(dir, { recursive: true });
});

test('readEvals returns no suites when there are no results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  assert.deepStrictEqual((await readEvals(dir)).suites, []);
  fs.rmSync(dir, { recursive: true });
});
