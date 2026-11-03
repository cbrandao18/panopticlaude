/* #ease-and-effort: one tree per post, agent steps then your next moves. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('ease');
  if (!root) return;
  const LABELS = {
    started: 'Started a workspace', skipped: 'Skipped', 'not-easy': 'Not an easy win', pr: 'Opened a draft PR',
    clear: 'Devlo clear, CI green', blocked: 'Blocked', drafted: 'Saved a Slack reply draft', 'dry-run': 'Dry run'
  };
  const WHOSE = { you: 'Needs you', agent: 'Agent working', closed: 'Closed' };
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const link = (href, text) => {
    const a = el('a', text);
    a.href = href; a.target = '_blank'; a.rel = 'noreferrer';
    return a;
  };
  const time = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .replace(/[\s ]*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);
  const open = new Map();
  let panelOpen = true;

  function branch(label, className, items) {
    const li = el('li', null, `ease-branch ${className}`);
    const list = el('ul');
    list.append(...items);
    li.append(el('span', label, 'ease-branch-label'), list);
    return li;
  }
  function eventLeaf(e) {
    const li = el('li', null, `ease-leaf ease-${e.kind}`);
    li.append(el('span', time(e.time), 'ease-time'), el('strong', LABELS[e.kind] || e.kind));
    const text = e.text.replace(/^ease-\d+ \((live|dry-run)\)$/, '$1 run');
    if (text) li.append(document.createTextNode(`: ${text}`));
    return li;
  }
  function actionLeaf(a) {
    const li = el('li', null, `ease-leaf ease-action ease-${a.state}`);
    li.append(el('span', { open: 'To do', done: 'Done', waiting: 'Agent', unknown: 'Check' }[a.state], 'ease-state'));
    li.append(a.url ? link(a.url, a.text) : el('span', a.text));
    if (a.state === 'unknown') li.append(el('span', ' (sent status isn’t tracked)', 'ease-muted'));
    if (a.draft) {
      const d = el('details', null, 'ease-draft');
      d.append(el('summary', 'Read the ticket draft'), el('pre', a.draft));
      li.append(d);
    }
    return li;
  }
  function post(p) {
    const li = el('li', null, `ease-post ease-${p.whose}`);
    const d = el('details');
    d.open = open.has(p.ts) ? open.get(p.ts) : p.whose === 'you';
    d.addEventListener('toggle', () => open.set(p.ts, d.open));
    const s = el('summary');
    s.append(el('span', WHOSE[p.whose], 'ease-badge'), el('span', p.title, 'ease-title'));
    s.append(el('span', [p.priority, time(p.updatedAt)].filter(Boolean).join(' · '), 'ease-muted'));
    const tree = el('ul', null, 'ease-tree');
    const you = p.actions.length ? p.actions.map(actionLeaf) : [el('li', 'Nothing for you', 'ease-leaf ease-muted')];
    tree.append(branch('Agent', 'ease-agent', p.events.map(eventLeaf)), branch('You', 'ease-you', you));
    const foot = el('p', null, 'ease-muted ease-foot');
    foot.append(link(p.link, 'Slack post'));
    if (p.workspace) foot.append(document.createTextNode(` · Workspace “${p.workspace.name}”${p.workspace.comment ? ` · ${p.workspace.comment}` : ''}`));
    d.append(s, tree, foot);
    li.append(d);
    return li;
  }
  function render(data) {
    const panel = el('details', null, 'ease-panel');
    panel.open = panelOpen;
    panel.addEventListener('toggle', () => { panelOpen = panel.open; });
    const counts = { you: 0, agent: 0, closed: 0 };
    for (const p of data.posts) counts[p.whose]++;
    const summary = el('summary');
    summary.append(el('h2', 'Ease & effort'), el('span', `${counts.you} need you · ${counts.agent} agent working · ${counts.closed} closed`, 'ease-muted'));
    const note = el('p', `From #ease-and-effort via ease-effort-watch on the VM. Updated ${time(data.refreshedAt)}.${data.mapError ? ` ${data.mapError}` : ''}`, 'ease-muted');
    panel.append(summary, note);
    if (data.error) panel.append(el('p', data.error, 'ease-error'));
    else if (!data.posts.length) panel.append(el('p', 'No posts handled yet.', 'ease-muted'));
    const list = el('ul', null, 'ease-posts');
    list.append(...data.posts.map(post));
    panel.append(list);
    root.replaceChildren(panel);
  }
  async function load() {
    try {
      const res = await fetch('/api/ease');
      render(await res.json());
    } catch {
      render({ refreshedAt: Date.now(), error: 'Couldn’t reach the dashboard server.', posts: [] });
    }
  }
  load();
  setInterval(load, 60000);
})();
