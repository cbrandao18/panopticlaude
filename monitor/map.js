// Read-only map of Orca workspaces and the Runs that coordinate them.
(function () {
  'use strict';
  const DAY = 86400000;
  const STATUSES = {
    'status-5': 'Daily process',
    'status-6': 'Fixes',
    'status-7': 'Features',
    'status-8': 'Automations',
    'in-progress': 'Unsorted'
  };
  const FINISHED = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled', 'abandoned', 'released']);
  const $ = (id) => document.getElementById(id);
  let data = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  function ago(ms) {
    if (!ms) return 'no activity';
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  }
  const runActive = (run) => run.tasks.some((t) => !FINISHED.has(t.state));
  const runFailed = (run) => run.tasks.some((t) => t.state === 'failed');
  const needsYou = (ws) => ws.agents.some((a) => !['working', 'done'].includes(a.state));

  function visible() {
    const showIdle = $('show-idle').checked;
    const all = data.hosts.flatMap((h) => h.workspaces);
    const recent = new Set(all.filter((ws) => Date.now() - ws.lastActivityAt < 7 * DAY).map((ws) => ws.key));
    const runs = data.hosts.flatMap((h) => h.runs)
      .filter((r) => $('show-done').checked || runActive(r) || r.tasks.some((t) => recent.has(t.workspace)));
    const linked = new Set(runs.flatMap((r) => r.tasks.map((t) => t.workspace)));
    const shown = all.filter((ws) =>
      showIdle || linked.has(ws.key) || Date.now() - ws.lastActivityAt < 7 * DAY || ws.agents.some((a) => a.state === 'working'));
    return { runs, workspaces: shown, hidden: all.length - shown.length };
  }

  function card(ws) {
    const working = ws.agents.filter((a) => a.state === 'working').length;
    const idle = Date.now() - ws.lastActivityAt > DAY;
    const chips = [
      working > 0 && el('span', { class: 'chip working' }, `${working} working`),
      needsYou(ws) && el('span', { class: 'chip attention' }, 'needs you'),
      ws.pr && el('a', { class: 'chip', href: ws.pr.url, target: '_blank', rel: 'noopener' }, `PR #${ws.pr.number}`),
      ws.issue && !ws.pr && (ws.repo === 'branch'
        ? el('a', { class: 'chip', href: `https://github.com/gobranch/branch/issues/${ws.issue}`, target: '_blank', rel: 'noopener' }, `#${ws.issue}`)
        : el('span', { class: 'chip' }, `#${ws.issue}`))
    ];
    const agents = ws.agents
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map((a) => el('li', null,
        el('p', { class: 'agent-head' }, `${a.type} · ${a.state} · ${ago(a.updatedAt)}`),
        a.title && el('p', { class: 'agent-title' }, a.title),
        a.last && el('p', { class: 'agent-last' }, a.last)));
    return el('details', { class: `ws ${ws.status}${idle ? ' idle' : ''}`, 'data-key': ws.key },
      el('summary', null,
        el('span', { class: 'ws-name' }, ws.name),
        el('span', { class: 'ws-meta' }, ago(ws.lastActivityAt)),
        el('span', { class: 'chips' }, chips)),
      el('div', { class: 'ws-body' },
        el('p', { class: 'ws-line' }, `${ws.repo} · ${ws.branch || 'no branch'} · ${STATUSES[ws.status] || ws.status}`),
        ws.comment && el('p', { class: 'ws-comment' }, ws.comment),
        agents.length ? el('ul', { class: 'agents' }, agents) : el('p', { class: 'ws-line' }, 'No agents recorded.')));
  }

  function tree(workspaces) {
    const byKey = new Map(workspaces.map((ws) => [ws.key, ws]));
    const kids = new Map();
    const roots = [];
    for (const ws of workspaces) {
      if (ws.parent && byKey.has(ws.parent)) (kids.get(ws.parent) || kids.set(ws.parent, []).get(ws.parent)).push(ws);
      else roots.push(ws);
    }
    const newest = (a, b) => b.lastActivityAt - a.lastActivityAt;
    const branch = (ws) => {
      const children = (kids.get(ws.key) || []).sort(newest);
      return el('div', { class: 'node' }, card(ws), children.length > 0 && el('div', { class: 'children' }, children.map(branch)));
    };
    return roots.sort(newest).map(branch);
  }

  function runCard(run) {
    const groups = new Map();
    for (const t of run.tasks) {
      const key = t.workspace || 'none';
      groups.set(key, [...(groups.get(key) || []), t]);
    }
    const state = runActive(run) ? 'active' : runFailed(run) ? 'failed' : 'done';
    return el('details', { class: `run ${state}`, 'data-key': run.key },
      el('summary', null,
        el('span', { class: 'ws-name' }, run.objective),
        el('span', { class: 'ws-meta' }, `on ${run.host === 'mac' ? 'Mac' : 'VM'} · ${run.tasks.length} workers · ${state}`)),
      el('ul', { class: 'agents' }, [...groups].map(([key, tasks]) => el('li', null,
        el('p', { class: 'agent-head' }, key === 'none' ? 'no workspace' : key.split('/').pop()),
        tasks.map((t) => el('p', { class: 'agent-title' }, `${t.title || 'untitled task'} · ${t.state}`))))));
  }

  function drawLinks(runs) {
    const svg = $('links');
    const box = $('map').getBoundingClientRect();
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    svg.replaceChildren();
    for (const run of runs) {
      const from = document.querySelector(`.run[data-key="${CSS.escape(run.key)}"]`);
      if (!from) continue;
      const a = from.getBoundingClientRect();
      const state = runActive(run) ? 'active' : runFailed(run) ? 'failed' : 'done';
      for (const key of new Set(run.tasks.map((t) => t.workspace).filter(Boolean))) {
        const to = document.querySelector(`.ws[data-key="${CSS.escape(key)}"]`);
        if (!to) continue;
        const b = to.getBoundingClientRect();
        const left = b.left < a.left;
        const x1 = (left ? a.left : a.right) - box.left;
        const y1 = a.top + 20 - box.top;
        const x2 = (left ? b.right : b.left) - box.left;
        const y2 = b.top + 20 - box.top;
        const mid = (x1 + x2) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
        path.setAttribute('class', `link ${state}`);
        svg.append(path);
      }
    }
  }

  function render() {
    if (!data) return;
    const { runs, workspaces, hidden } = visible();
    for (const host of data.hosts) {
      const body = document.querySelector(`#lane-${host.id} .lane-body`);
      const mine = workspaces.filter((ws) => ws.host === host.id);
      body.replaceChildren(
        host.error ? el('p', { class: 'error' }, `Couldn't read the ${host.label}: ${host.error}`) : '',
        ...(mine.length ? tree(mine) : [el('p', { class: 'ws-line' }, 'No recent workspaces.')]));
    }
    document.querySelector('#lane-runs .lane-body').replaceChildren(
      ...(runs.length ? runs.map(runCard) : [el('p', { class: 'ws-line' }, 'No recent Runs. Workspaces started with agent launch have no Run.')]));
    const counts = data.hosts.map((h) => `${h.label} ${h.workspaces.length}`).join(' · ');
    $('connection').textContent = `Read ${ago(data.refreshedAt)} · ${counts} workspaces${hidden ? ` · ${hidden} idle hidden` : ''}`;
    drawLinks(runs);
  }

  async function load() {
    try {
      const res = await fetch('/api/map');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Map unavailable.');
      data = body;
      $('error').hidden = true;
    } catch (e) {
      $('error').textContent = `Couldn't load the map: ${e.message}`;
      $('error').hidden = false;
    }
    // Keep open cards open across refreshes.
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    render();
    for (const d of document.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
    if (open.size) drawLinks(visible().runs);
  }

  $('legend').replaceChildren(...Object.entries(STATUSES).map(([id, label]) => el('span', { class: `swatch ${id}` }, label)));
  $('show-idle').addEventListener('change', render);
  $('show-done').addEventListener('change', render);
  $('refresh').addEventListener('click', load);
  $('map').addEventListener('toggle', () => data && drawLinks(visible().runs), true);
  window.addEventListener('resize', () => data && drawLinks(visible().runs));
  load();
  setInterval(load, 30000);
})();
