// Live map of Orca workspaces on the Mac and the VM, and the Runs that coordinate them.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const HOSTS = [
  { id: 'mac', label: 'Mac', args: [] },
  { id: 'vm', label: 'VM', args: ['--environment', 'cloud'] }
];
// A session id makes a paired server reject the call as coming from another host.
const env = { ...process.env };
for (const key of ['ORCA_AGENT_SESSION_ID', 'ORCA_AGENT_SESSION_SPAWN_TOKEN', 'ORCA_STRUCTURED_SESSION']) delete env[key];

function orcaRunner(run = promisify(execFile)) {
  return async (args) => {
    const { stdout } = await run(process.env.ORCA_CLI_COMMAND || '/usr/local/bin/orca', [...args, '--json'], {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      env
    });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.error?.message || 'Orca returned an error.');
    return parsed.result;
  };
}

const clip = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text || '');

function workspace(host, w) {
  const pr = w.linkedPR;
  return {
    key: `${host}|${w.worktreeId}`,
    host,
    name: w.displayName || w.branch?.replace('refs/heads/', '') || w.path,
    branch: w.branch?.replace('refs/heads/', '') || '',
    repo: w.repo,
    status: w.workspaceStatus,
    parent: w.parentWorktreeId ? `${host}|${w.parentWorktreeId}` : null,
    comment: w.comment || '',
    pinned: Boolean(w.isPinned),
    lastActivityAt: w.lastActivityAt || w.createdAt || 0,
    live: w.liveTerminalCount || 0,
    pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
    issue: Number.isInteger(w.linkedIssue) ? w.linkedIssue : null,
    agents: (w.agents || []).map((a) => ({
      state: a.state,
      type: a.agentType,
      title: clip(a.taskTitle || a.displayName || a.prompt, 140),
      last: clip(a.lastAssistantMessage, 900),
      updatedAt: a.updatedAt || 0
    }))
  };
}

const skipRun = (r) => r.legacy || r.id === 'run_unbound' || /^Coordinated from /.test(r.objective || '');

async function readHost(host, orca) {
  const [ps, runList] = await Promise.all([
    orca(['worktree', 'ps', '--limit', '500', ...host.args]),
    orca(['orchestration', 'run-list', ...host.args])
  ]);
  const workspaces = ps.worktrees.filter((w) => !w.isArchived).map((w) => workspace(host.id, w));
  const other = HOSTS.find((h) => h.id !== host.id).id;
  const runs = await Promise.all(
    runList.runs.filter((r) => !skipRun(r)).map(async (r) => {
      const [tasks, workers] = await Promise.all([
        orca(['orchestration', 'task-list', '--run', r.id, ...host.args]),
        orca(['orchestration', 'worker-list', '--run', r.id, '--include-remote', '--limit', '100', ...host.args])
      ]);
      const titles = new Map(tasks.tasks.map((t) => [t.id, t]));
      return {
        key: `${host.id}|${r.id}`,
        host: host.id,
        objective: clip(r.objective, 200),
        tasks: workers.workers.map((w) => ({
          title: clip(titles.get(w.taskId)?.title, 120),
          status: titles.get(w.taskId)?.status || w.state,
          state: w.state,
          liveness: w.liveness,
          // A worker on this runtime reports host "local"; anything else is the paired server.
          workspace: w.workspace ? `${w.host === 'local' ? host.id : other}|${w.workspace}` : null
        }))
      };
    })
  );
  return { id: host.id, label: host.label, workspaces, runs: runs.filter((r) => r.tasks.length) };
}

function createMapReader(orca = orcaRunner(), ttl = 30000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= Promise.all(
      HOSTS.map((h) => readHost(h, orca).catch((e) => ({ id: h.id, label: h.label, error: clip(e.message, 300), workspaces: [], runs: [] })))
    )
      .then((hosts) => (cached = { refreshedAt: Date.now(), hosts }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createMapReader, orcaRunner, readHost };
