// Org chart of Christie's work: Runs and their workers, then workspaces by sidebar status, nested by parent.
// Highlights what needs her, what is stuck or failed, and what is working. Read-only.
import { h, render } from './vendor/preact.js';
import { useEffect, useState } from './vendor/hooks.js';
import htm from './vendor/htm.js';
import { Masthead, openInOrca } from './ui.js';
import { Bird } from './roost.js';

const html = htm.bind(h);
const DAY = 86400000;
const QUIET_AFTER = 3 * DAY;
const COLUMNS = [
  ['status-6', 'Fixes'],
  ['status-7', 'Features'],
  ['status-5', 'Daily process'],
  ['status-8', 'Automations'],
  ['other', 'Unsorted']
];

const meridiem = (text) => text.replace(/[\s ]*([AP])M\b/g, (m, l) => `${l.toLowerCase()}m`);
const clock = (ms) => meridiem(new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return `${Math.max(min, 0)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
};

// What state a workspace is in, most urgent first; CSS keys off the string.
function stateOf(ws, now = Date.now()) {
  if (/^You:/i.test(ws.comment)) return 'you';
  if (ws.failed) return 'failed';
  if (ws.agents.some((a) => !['done', 'working'].includes(a.state))) return 'stuck';
  if (ws.agents.some((a) => a.state === 'working')) return 'working';
  // Unknown activity (0) is never stuck or quiet; a comment saying the agent is done isn't stuck either.
  if (/^Agent:(?!\s*(done|finished|complete))/i.test(ws.comment) && ws.activeAt && now - ws.activeAt > DAY) return 'stuck';
  if (ws.activeAt && now - ws.activeAt > QUIET_AFTER) return 'quiet';
  return 'idle';
}
const RANK = { you: 0, failed: 1, stuck: 2, working: 3, idle: 4, quiet: 5 };
const LABEL = { you: 'Needs you', failed: 'Failed', stuck: 'Stuck', working: 'Working', idle: '', quiet: '' };

function build(data) {
  const all = data.hosts.flatMap((host) => host.workspaces);
  const byKey = new Map(all.map((ws) => [ws.key, { ...ws, children: [] }]));
  const runs = data.hosts.flatMap((host) => host.runs);
  // A failed Run task marks the workspace it ran in.
  for (const run of runs) for (const t of run.tasks) if (t.status === 'failed' && byKey.has(t.workspace)) byKey.get(t.workspace).failed = true;
  const now = Date.now();
  for (const ws of byKey.values()) {
    ws.activeAt = Math.max(ws.lastActivityAt || 0, ...ws.agents.map((a) => a.updatedAt || 0));
    ws.state = stateOf(ws, now);
  }
  const roots = [];
  for (const ws of byKey.values()) (ws.parent && byKey.has(ws.parent) ? byKey.get(ws.parent).children : roots).push(ws);
  // A branch is as urgent as its most urgent node.
  const rank = (ws) => Math.min(RANK[ws.state], ...ws.children.map(rank));
  const sort = (list) => list.sort((a, b) => rank(a) - rank(b) || b.activeAt - a.activeAt).forEach((ws) => sort(ws.children));
  sort(roots);
  const columns = COLUMNS.map(([id, label]) => ({
    id,
    label,
    roots: roots.filter((ws) => (COLUMNS.some(([c]) => c === ws.status) ? ws.status : 'other') === id)
  }));
  const liveRuns = runs
    .map((r) => ({ ...r, failed: r.tasks.some((t) => t.status === 'failed'), open: r.tasks.some((t) => !['completed', 'failed'].includes(t.status)) }))
    .filter((r) => r.open || r.failed);
  const counts = { you: 0, failed: 0, stuck: 0, working: 0 };
  for (const ws of byKey.values()) if (ws.state in counts) counts[ws.state]++;
  return { columns, runs: liveRuns, counts, rank };
}

function Node({ ws, showQuiet, rank }) {
  const visible = ws.children.filter((c) => showQuiet || rank(c) < RANK.quiet);
  return html`
    <li class=${`node ${ws.state}`}>
      <div class="card" title=${ws.path}>
        <div class="card-top">
          <span class=${`presence ${ws.state}`} aria-hidden="true"></span><${Bird} state=${ws.state} /><button class="name open-ws" type="button" title="Open in Orca" onClick=${() => openInOrca(ws.key, ws.name)}>${ws.name}</button>
          <span class="host">${ws.host === 'vm' ? 'VM' : 'Mac'}</span>
        </div>
        ${LABEL[ws.state] && html`<span class=${`badge ${ws.state}`}>${LABEL[ws.state]}</span>`}
        ${ws.comment && html`<p class="comment">${ws.comment.replace(/^(You|Agent):\s*/i, '')}</p>`}
        <p class="meta">
          ${ws.pr && html`<a href=${ws.pr.url}>PR #${ws.pr.number}</a> · `}
          ${ws.agents.filter((a) => a.state === 'working').length > 0 && `${ws.agents.filter((a) => a.state === 'working').length} working · `}
          ${ws.activeAt ? `active ${ago(ws.activeAt)} ago` : 'no activity recorded'}
        </p>
      </div>
      ${visible.length > 0 && html`<ul>${visible.map((c) => html`<${Node} key=${c.key} ws=${c} showQuiet=${showQuiet} rank=${rank} />`)}</ul>`}
    </li>`;
}

function Column({ col, showQuiet, rank }) {
  const visible = col.roots.filter((ws) => showQuiet || rank(ws) < RANK.quiet);
  const quiet = col.roots.length - visible.length;
  return html`
    <section class=${`column c-${col.id}`} aria-labelledby=${`col-${col.id}`}>
      <h2 id=${`col-${col.id}`}>${col.label} <span class="count">${col.roots.length}</span></h2>
      ${visible.length ? html`<ul class="tree">${visible.map((ws) => html`<${Node} key=${ws.key} ws=${ws} showQuiet=${showQuiet} rank=${rank} />`)}</ul>` : html`<p class="now-muted empty"><${Bird} state="quiet" />Nothing active.</p>`}
      ${quiet > 0 && html`<p class="now-muted quiet-note">${quiet} quiet for ${QUIET_AFTER / DAY}+ days</p>`}
    </section>`;
}

function Runs({ runs }) {
  if (!runs.length) return null;
  return html`
    <section class="runs" aria-labelledby="runs-title">
      <h2 id="runs-title">Coordinators <span class="count">${runs.length}</span></h2>
      <ul class="tree">
        ${runs.map((r) => html`
          <li key=${r.key} class=${`node ${r.failed ? 'failed' : 'working'}`}>
            <div class="card"><div class="card-top"><span class="name">${r.objective}</span><span class="host">${r.host === 'vm' ? 'VM' : 'Mac'}</span></div></div>
            ${r.tasks.some((t) => t.status === 'completed') && html`<p class="meta run-done">${r.tasks.filter((t) => t.status === 'completed').length} of ${r.tasks.length} tasks completed</p>`}
            <ul>${r.tasks.filter((t) => t.status !== 'completed').map((t, i) => html`
              <li key=${i} class=${`node ${t.status === 'failed' ? 'failed' : t.status === 'completed' ? 'idle' : 'working'}`}>
                <div class="card"><span class="name">${t.title || 'Untitled task'}</span><p class="meta">${t.status}</p></div>
              </li>`)}</ul>
          </li>`)}
      </ul>
    </section>`;
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showQuiet, setShowQuiet] = useState(false);
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/map', { signal: AbortSignal.timeout(60000) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setData(body);
        setError(null);
      } catch (e) {
        setError(e.message);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);
  const view = data && build(data);
  return html`
    <${Masthead} page="/map" status=${error ? `Couldn't refresh: ${error}` : data ? `Updated ${clock(data.refreshedAt)}` : 'Reading Orca on the Mac and the VM…'} />
    ${view && html`
      <div class="summary">
        <span class="badge you">${view.counts.you} need you</span>
        <span class="badge failed">${view.counts.failed} failed</span>
        <span class="badge stuck">${view.counts.stuck} stuck</span>
        <span class="badge working">${view.counts.working} working</span>
        <label class="toggle"><input type="checkbox" checked=${showQuiet} onChange=${(e) => setShowQuiet(e.currentTarget.checked)} /> Show quiet workspaces</label>
      </div>
      ${data.hosts.filter((host) => host.error).map((host) => html`<p class="error-line" key=${host.id}>Couldn't read the ${host.label}: ${host.error}</p>`)}
      <${Runs} runs=${view.runs} />
      <div class="columns">${view.columns.map((col) => html`<${Column} key=${col.id} col=${col} showQuiet=${showQuiet} rank=${view.rank} />`)}</div>`}`;
}


const root = document.getElementById('app');
root.replaceChildren();
render(html`<${App} />`, root);
