// Read-only map of Orca workspaces and the Runs that coordinate them.
(function () {
  'use strict';
  const DAY = 86400000;
  const NEEDS_SHOWN = 5;
  const STATUSES = {
    'status-5': 'Daily process',
    'status-6': 'Fixes',
    'status-7': 'Features',
    'status-8': 'Automations',
    'in-progress': 'Unsorted'
  };
  const HOSTS = { mac: 'Mac', vm: 'VM' };
  const FINISHED = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled', 'abandoned', 'released']);
  const $ = (id) => document.getElementById(id);
  let data = null;
  let showAllNeeds = false;

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
  const focusView = () => document.querySelector('input[name="view"]:checked').value === 'focus';
  const runActive = (run) => run.tasks.some((t) => !FINISHED.has(t.state));
  const runState = (run) => (runActive(run) ? 'active' : run.tasks.some((t) => t.state === 'failed') ? 'failed' : 'done');
  const needsYou = (ws) => /^You:/i.test(ws.comment);
  const unclear = (ws) => ws.agents.some((a) => !['working', 'done'].includes(a.state));
  const working = (ws) => ws.agents.some((a) => a.state === 'working');
  const newest = (a, b) => b.lastActivityAt - a.lastActivityAt;
  const short = (text) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

  function visible() {
    const all = data.hosts.flatMap((h) => h.workspaces);
    const allRuns = data.hosts.flatMap((h) => h.runs);
    const runs = allRuns.filter((r) => $('show-done').checked || runActive(r));
    const needs = all.filter(needsYou).sort(newest);
    let lanes;
    if (focusView()) {
      const pinned = new Set(all.filter((ws) => ws.pinned).map((ws) => ws.key));
      const linked = new Set(runs.filter(runActive).flatMap((r) => r.tasks.map((t) => t.workspace)));
      lanes = all.filter((ws) => !needsYou(ws) && (pinned.has(ws.key) || pinned.has(ws.parent) || working(ws) || unclear(ws) || linked.has(ws.key)));
    } else {
      const linked = new Set(runs.flatMap((r) => r.tasks.map((t) => t.workspace)));
      lanes = all.filter((ws) => $('show-idle').checked || linked.has(ws.key) || Date.now() - ws.lastActivityAt < 7 * DAY || working(ws));
    }
    const shownKeys = new Set([...needs, ...lanes].map((ws) => ws.key));
    return { all, allRuns, runs, needs, lanes, hidden: all.filter((ws) => !shownKeys.has(ws.key)).length };
  }

  // The newest Run whose workers used this workspace, if any.
  function coordinator(ws, allRuns) {
    const runs = allRuns.filter((r) => r.tasks.some((t) => t.workspace === ws.key));
    return runs.find(runActive) || runs[0] || null;
  }

  function card(ws, ctx, { withHost = false } = {}) {
    const busy = ws.agents.filter((a) => a.state === 'working').length;
    const idle = Date.now() - ws.lastActivityAt > DAY;
    const run = coordinator(ws, ctx.allRuns);
    const parent = ws.parent && ctx.byKey.get(ws.parent);
    const chips = [
      withHost && el('span', { class: 'chip' }, HOSTS[ws.host]),
      ws.pinned && el('span', { class: 'chip pinned' }, 'pinned'),
      busy > 0 && el('span', { class: 'chip working' }, `${busy} working`),
      unclear(ws) && el('span', { class: 'chip attention' }, 'check status'),
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
    return el('details', { class: `ws ${ws.status}${needsYou(ws) ? ' needs-you' : ''}`, 'data-key': ws.key },
      el('summary', null,
        el('span', { class: 'ws-name' }, ws.name),
        el('span', { class: `ws-meta${idle ? ' stale' : ''}` }, ago(ws.lastActivityAt)),
        ws.comment && el('span', { class: 'ws-comment' }, ws.comment),
        parent && withHost && el('span', { class: 'ws-relation' }, `Under ${parent.name}`),
        run && runActive(run) && el('span', { class: 'ws-relation' }, `Worker for: ${short(run.objective)} · ${HOSTS[run.host]}`),
        el('span', { class: 'chips' }, chips)),
      el('div', { class: 'ws-body' },
        el('p', { class: 'ws-line' }, `${STATUSES[ws.status] || ws.status} · ${ws.repo} · ${ws.branch || 'no branch'}`),
        el('p', { class: 'ws-line' }, !run ? 'No coordinator recorded.'
          : runActive(run) ? `Coordinator: ${run.objective} · ${HOSTS[run.host]}`
          : `Last coordinator (${runState(run)}): ${run.objective} · ${HOSTS[run.host]}`),
        agents.length ? el('ul', { class: 'agents' }, agents) : el('p', { class: 'ws-line' }, 'No agents recorded.')));
  }

  function tree(workspaces, ctx) {
    const byKey = new Map(workspaces.map((ws) => [ws.key, ws]));
    const kids = new Map();
    const roots = [];
    for (const ws of workspaces) {
      if (ws.parent && byKey.has(ws.parent)) (kids.get(ws.parent) || kids.set(ws.parent, []).get(ws.parent)).push(ws);
      else roots.push(ws);
    }
    const order = (a, b) => b.pinned - a.pinned || newest(a, b);
    const branch = (ws) => {
      const children = (kids.get(ws.key) || []).sort(order);
      return el('div', { class: 'node' }, card(ws, ctx), children.length > 0 && el('div', { class: 'children' }, children.map(branch)));
    };
    return roots.sort(order).map(branch);
  }

  function runCard(run) {
    const groups = new Map();
    for (const t of run.tasks) {
      const key = t.workspace || 'none';
      groups.set(key, [...(groups.get(key) || []), t]);
    }
    const state = runState(run);
    return el('details', { class: `run ${state}`, 'data-key': run.key },
      el('summary', null,
        el('span', { class: 'ws-name' }, run.objective),
        el('span', { class: 'ws-meta' }, `on ${HOSTS[run.host]} · ${run.tasks.length} workers · ${state}`)),
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
      for (const key of new Set(run.tasks.map((t) => t.workspace).filter(Boolean))) {
        const to = document.querySelector(`.lane .ws[data-key="${CSS.escape(key)}"]`);
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
        path.setAttribute('class', `link ${runState(run)}`);
        svg.append(path);
      }
    }
  }

  function renderNeeds(needs, ctx) {
    const shown = showAllNeeds ? needs : needs.slice(0, NEEDS_SHOWN);
    $('needs-title').textContent = `Needs you (${needs.length})`;
    document.querySelector('#needs .needs-body').replaceChildren(
      ...(needs.length ? shown.map((ws) => card(ws, ctx, { withHost: true })) : [el('p', { class: 'ws-line' }, 'Nothing is waiting on you. Agents mark a workspace here with a "You:" comment.')]),
      needs.length > NEEDS_SHOWN && el('button', { class: 'text', id: 'needs-more', type: 'button' },
        showAllNeeds ? 'Show fewer' : `Show all ${needs.length}`));
  }

  function render() {
    if (!data) return;
    const v = visible();
    const ctx = { allRuns: v.allRuns, byKey: new Map(v.all.map((ws) => [ws.key, ws])) };
    renderNeeds(v.needs, ctx);
    for (const host of data.hosts) {
      const mine = v.lanes.filter((ws) => ws.host === host.id);
      const empty = focusView() ? 'Nothing pinned or running here.' : 'No recent workspaces.';
      document.querySelector(`#lane-${host.id} .lane-body`).replaceChildren(
        host.error ? el('p', { class: 'error' }, `Couldn't read the ${host.label}: ${host.error}. Use Refresh to retry.`) : '',
        ...(mine.length ? tree(mine, ctx) : [el('p', { class: 'ws-line' }, empty)]));
    }
    $('map').classList.toggle('no-runs', !v.runs.length);
    document.querySelector('#lane-runs .lane-body').replaceChildren(...v.runs.map(runCard));
    $('show-idle-label').hidden = focusView();
    $('view-note').textContent = focusView()
      ? 'Focus shows what needs you, then pinned work, running agents and active Runs.'
      : 'All workspaces active in the last 7 days.';
    const counts = data.hosts.map((h) => `${h.label} ${h.workspaces.length}`).join(' · ');
    $('connection').textContent = `Read ${ago(data.refreshedAt)} · ${counts} workspaces${v.hidden ? ` · ${v.hidden} hidden` : ''}`;
    drawLinks(v.runs);
  }

  // Re-render without losing which cards are open or which card has keyboard focus.
  function rerender() {
    const open = new Set([...document.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    const focused = document.activeElement?.closest('details')?.dataset.key;
    const inNeeds = Boolean(document.activeElement?.closest('#needs'));
    render();
    for (const d of document.querySelectorAll('details')) if (open.has(d.dataset.key)) d.open = true;
    if (focused) document.querySelector(`${inNeeds ? '#needs' : '#map'} details[data-key="${CSS.escape(focused)}"] summary`)?.focus();
    if (open.size && data) drawLinks(visible().runs);
  }

  async function load() {
    $('refresh').disabled = true;
    try {
      const res = await fetch('/api/map');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Map unavailable.');
      data = body;
      $('error').hidden = true;
    } catch (e) {
      $('error').textContent = `Couldn't load the map: ${e.message}. Use Refresh to retry.`;
      $('error').hidden = false;
    } finally {
      $('refresh').disabled = false;
    }
    rerender();
  }

  for (const input of document.querySelectorAll('input[name="view"], #show-idle, #show-done')) input.addEventListener('change', rerender);
  $('needs').addEventListener('click', (e) => {
    if (e.target.id !== 'needs-more') return;
    showAllNeeds = !showAllNeeds;
    rerender();
    $('needs-more')?.focus();
  });
  $('refresh').addEventListener('click', load);
  $('map').addEventListener('toggle', () => data && drawLinks(visible().runs), true);
  window.addEventListener('resize', () => data && drawLinks(visible().runs));
  load();
  setInterval(load, 30000);
})();
