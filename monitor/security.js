/* Security tickets from the weekly access-check audit: parent tickets, their sub-issues and fix PRs. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('security');
  if (!root) return;
  const STATUS = { todo: 'To do', 'draft-pr': 'Draft PR', 'in-review': 'In review', merged: 'Merged', done: 'Done', dropped: 'Dropped' };
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  // Opens in the Mac's default browser through the server; falls back to a new tab.
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
  const time = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .replace(/[\s ]*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let panelOpen = true;
  const openFields = new Set();

  function row(t) {
    const li = el('li', null, `security-row security-${t.status}`);
    li.append(el('span', STATUS[t.status] || t.status, 'security-state'));
    const main = el('span', null, 'security-main');
    main.append(link(t.url, `#${t.number}`), document.createTextNode(` ${t.title}`));
    for (const pr of t.prs || []) {
      if (pr.state === 'CLOSED') continue;
      main.append(el('span', ' · ', 'security-muted'), link(pr.url, `PR #${pr.number}`),
        el('span', ` ${pr.state === 'MERGED' ? 'merged' : pr.isDraft ? 'draft' : 'open'}`, 'security-muted'));
    }
    li.append(main);
    if (t.fields.length) {
      const d = el('details', null, 'security-fields');
      d.open = openFields.has(t.number);
      d.addEventListener('toggle', () => (d.open ? openFields.add(t.number) : openFields.delete(t.number)));
      d.append(el('summary', plural(t.fields.length, 'field')));
      const list = el('ul');
      list.append(...t.fields.map((f) => el('li', f)));
      d.append(list);
      li.append(d);
    }
    return li;
  }
  function card(title, url, tickets, extra) {
    const li = el('li', null, 'security-card');
    const head = el('div', null, 'security-card-head');
    head.append(url ? link(url, title) : el('strong', title));
    const fixed = tickets.filter((t) => t.status === 'done' || t.status === 'dropped').length;
    head.append(el('span', extra || `${fixed} of ${tickets.length} closed`, 'security-muted'));
    const list = el('ul', null, 'security-rows');
    list.append(...tickets.map(row));
    li.append(head, list);
    return li;
  }
  function runLine(run) {
    if (!run?.last) return 'It hasn’t run yet.';
    const [kind] = run.last.text.split(' ');
    if (kind === 'failed') return `Last run failed ${time(run.last.time)}: ${run.last.text.slice(7)}.`;
    if (kind === 'started') return `Run in progress since ${time(run.last.time)}.`;
    return `Last run ${time(run.last.time)}: ${run.last.text.replace(/^finished\s*/, '').replace(/\s*report=\S+/, '')}.`;
  }
  function render(data) {
    const panel = el('details', null, 'security-panel');
    panel.open = panelOpen;
    panel.addEventListener('toggle', () => { panelOpen = panel.open; });
    const c = data.counts || {};
    const summary = el('summary');
    summary.append(el('h2', 'Security'), el('span', [
      `${c.todo || 0} to do`, `${(c['in-review'] || 0) + (c['draft-pr'] || 0)} with a PR`, `${(c.done || 0) + (c.merged || 0)} fixed`
    ].join(' · '), 'security-muted'));
    panel.append(summary);
    const note = el('p', null, 'security-muted security-note');
    note.textContent = data.error ? '' : `From the weekly access-check audit, Sundays 9pm on the VM. ${runLine(data.run)} `
      + `${data.fieldCount} agency-reachable ID fields watched, ${data.openGaps} with open gaps. Updated ${time(data.refreshedAt)}.`;
    if (!data.error) panel.append(note);
    if (data.workspace) {
      panel.append(el('p', `Workspace “${data.workspace.name}”${data.workspace.comment ? ` · ${data.workspace.comment}` : ''}`, 'security-muted security-note'));
    }
    if (data.error) panel.append(el('p', data.error, 'security-error'));
    const cards = el('ul', null, 'security-cards');
    for (const g of data.groups || []) cards.append(card(`#${g.parent.number} ${g.parent.title}`, g.parent.url, g.tickets));
    if (data.tracked?.length) cards.append(card('Tracked by existing tickets and PRs', null, data.tracked, plural(data.tracked.length, 'item')));
    if (!data.error && !cards.children.length) panel.append(el('p', 'No Security tickets from the audit yet.', 'security-muted'));
    panel.append(cards);
    root.replaceChildren(panel);
  }
  async function load() {
    try {
      const res = await fetch('/api/security');
      render(await res.json());
    } catch {
      render({ refreshedAt: Date.now(), error: 'Couldn’t reach the dashboard server.', groups: [], tracked: [] });
    }
  }
  load();
  setInterval(load, 120000);
})();
