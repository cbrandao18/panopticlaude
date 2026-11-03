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
