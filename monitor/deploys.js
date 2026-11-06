/* Deploys: each dev environment's pinned trunk, head, entries and open flags, plus a banner when the deployer is quiet. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('deploys');
  if (!root) return;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const link = (href, text) => {
    const a = el('a', text);
    a.href = href; a.target = '_blank'; a.rel = 'noreferrer';
    a.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        const res = await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
          body: JSON.stringify({ url: href })
        });
        if (!res.ok) throw new Error();
      } catch {
        window.open(href, '_blank', 'noreferrer');
      }
    });
    return a;
  };
  const am = (s) => s.replace(/[\s ]*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);
  const time = (value) => {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms)
      ? am(new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
      : String(value);
  };
  const day = (ymd) => {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(ymd || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ymd;
  };
  const PILL = { deployed: 'ok', waiting: 'warn', stale: 'warn', merged: 'done', closed: 'done' };
  const pillClass = (status) => PILL[status] || (/^(failed|skipped)/.test(status) ? 'bad' : 'warn');
  let panelOpen = true;

  function banner(data) {
    const messages = [];
    if (data.stale) {
      messages.push(data.lastGate
        ? `The deployer hasn’t checked in since ${time(data.lastGate)}.`
        : 'No deployer heartbeat yet.');
    }
    for (const env of data.envs || []) for (const f of env.flags) messages.push(`${env.env}: ${f.message}`);
    if (!messages.length) return null;
    const box = el('div', null, 'deploys-banner');
    box.setAttribute('role', 'alert');
    box.append(...messages.map((m) => el('p', m)));
    return box;
  }
  function fact(label, value) {
    const wrap = el('div');
    wrap.append(el('dt', label), el('dd', value || 'None'));
    return wrap;
  }
  function entry(e) {
    const li = el('li', null, 'deploys-entry');
    const name = el('span', null, 'deploys-name');
    name.append(e.url ? link(e.url, `PR ${e.label}`) : el('span', e.label));
    const pill = el('span', e.status === 'merged' ? 'merged, can remove' : e.status, `deploys-pill deploys-${pillClass(e.status)}`);
    li.append(name, pill);
    if (e.note) li.append(el('span', e.note, 'deploys-muted deploys-note'));
    return li;
  }
  function card(env) {
    const li = el('li', null, 'deploys-card');
    const head = el('div', null, 'deploys-card-head');
    head.append(el('strong', env.env));
    if (env.staffUrl) head.append(link(env.staffUrl, env.staffUrl.replace(/^https?:\/\//, '')));
    li.append(head);
    if (env.error) {
      li.append(el('p', env.error, 'deploys-muted'));
      return li;
    }
    const facts = el('dl', null, 'deploys-facts');
    facts.append(fact('Head', env.head), fact('Pinned trunk', day(env.pinnedTrunk)), fact('Last run', env.lastRun && time(env.lastRun)), fact('Lock', env.lock));
    li.append(facts);
    const list = el('ul', null, 'deploys-entries');
    list.append(...env.entries.map(entry));
    li.append(env.entries.length ? list : el('p', 'No PRs or branches on this environment.', 'deploys-muted'));
    return li;
  }
  function render(data) {
    const panel = el('details', null, 'deploys-panel');
    panel.open = panelOpen;
    panel.addEventListener('toggle', () => { panelOpen = panel.open; });
    const summary = el('summary');
    summary.append(el('h2', 'Deploys'), el('span', `Updated ${time(data.refreshedAt)}`, 'deploys-muted'));
    panel.append(summary);
    const alert = banner(data);
    if (alert) panel.append(alert);
    if (data.error) panel.append(el('p', data.error, 'deploys-error'));
    const cards = el('ul', null, 'deploys-cards');
    cards.append(...(data.envs || []).map(card));
    panel.append(cards);
    if (data.log?.length) {
      const d = el('details', null, 'deploys-log');
      d.append(el('summary', 'Recent deploy log'));
      const list = el('ul');
      list.append(...data.log.slice(-15).reverse().map((l) => el('li', `${l.time ? time(l.time) : ''} ${l.env || ''} ${l.text}`.trim())));
      d.append(list);
      panel.append(d);
    }
    root.replaceChildren(panel);
  }
  async function load() {
    try {
      const res = await fetch('/api/deploys');
      render(await res.json());
    } catch {
      render({ refreshedAt: Date.now(), error: 'Couldn’t reach the dashboard server.', envs: [], stale: false });
    }
  }
  load();
  setInterval(load, 30000);
})();
