const test = require('node:test');
const assert = require('node:assert');
const { createMapReader } = require('./map-api');

const ws = (id, extra = {}) => ({ worktreeId: id, displayName: id, branch: `refs/heads/${id}`, agents: [], ...extra });

function fakeOrca(calls = []) {
  return async (args) => {
    calls.push(args);
    const vm = args.includes('cloud');
    const [group, cmd] = args;
    if (group === 'worktree') {
      return { worktrees: vm ? [ws('vm-a')] : [ws('mac-a'), ws('mac-b', { parentWorktreeId: 'mac-a' }), ws('old', { isArchived: true })] };
    }
    if (cmd === 'run-list') {
      return {
        runs: vm
          ? [{ id: 'run_mirror', objective: 'Coordinated from abc' }]
          : [{ id: 'run_1', objective: 'Ship it' }, { id: 'run_unbound', objective: 'Mail' }, { id: 'run_legacy_local', legacy: true }]
      };
    }
    if (cmd === 'task-list') return { tasks: [{ id: 't1', title: 'Fix', status: 'completed' }] };
    if (cmd === 'worker-list') {
      return {
        workers: [
          { taskId: 't1', state: 'succeeded', host: 'local', workspace: 'mac-b' },
          { taskId: 't1', state: 'running', host: 'remote-id', workspace: 'vm-a' },
          { taskId: 't1', state: 'failed', host: 'local', workspace: null }
        ]
      };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
}

test('map reads both hosts, keeps lineage and maps remote workers to the VM', async () => {
  const calls = [];
  const map = await createMapReader(fakeOrca(calls))();
  const [mac, vm] = map.hosts;
  assert.deepStrictEqual(mac.workspaces.map((w) => w.key), ['mac|mac-a', 'mac|mac-b']);
  assert.strictEqual(mac.workspaces[1].parent, 'mac|mac-a');
  assert.strictEqual(mac.workspaces[1].branch, 'mac-b');
  assert.deepStrictEqual(mac.runs.map((r) => r.key), ['mac|run_1']);
  assert.deepStrictEqual(mac.runs[0].tasks.map((t) => t.workspace), ['mac|mac-b', 'vm|vm-a', null]);
  assert.deepStrictEqual(vm.runs, []);
  assert.ok(calls.some((a) => a[0] === 'worktree' && a.includes('cloud')));
});

test('a failing host is reported without hiding the other', async () => {
  const orca = fakeOrca();
  const map = await createMapReader(async (args) => {
    if (args.includes('cloud')) throw new Error('VM unreachable');
    return orca(args);
  })();
  assert.strictEqual(map.hosts[1].error, 'VM unreachable');
  assert.strictEqual(map.hosts[0].workspaces.length, 2);
});

test('openWorkspace switches to the first terminal on the right host and refuses unknown keys', async () => {
  const { openWorkspace } = require('./map-api');
  const map = { hosts: [{ id: 'vm', workspaces: [{ key: 'vm|repo::/w/a', host: 'vm', name: 'A' }, { key: 'vm|repo::/w/b', host: 'vm', name: 'B' }] }] };
  const calls = [];
  const orca = async (args) => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: args[3] === 'id:repo::/w/a' ? [{ handle: 'term_1' }] : [] };
    return { focus: { navigated: true } };
  };
  assert.deepEqual(await openWorkspace('vm|repo::/w/a', map, orca), { opened: true });
  assert.deepEqual(calls, [
    ['terminal', 'list', '--worktree', 'id:repo::/w/a', '--environment', 'cloud'],
    ['terminal', 'switch', '--terminal', 'term_1', '--environment', 'cloud']
  ]);
  assert.match((await openWorkspace('vm|repo::/w/b', map, orca)).error, /no open terminal/);
  assert.match((await openWorkspace('mac|evil', map, orca)).error, /no longer on the map/);
  assert.equal(calls.length, 3);
});
