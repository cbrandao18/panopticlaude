/* #ease-and-effort: one tree per post, agent steps then your next moves. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('ease');
  if (!root) return;
  const LABELS = {
    started: 'Started a workspace', filed: 'Filed', skipped: 'Skipped', 'not-easy': 'Not an easy win', pr: 'Opened a draft PR',
    clear: 'Devlo clear, CI green', blocked: 'Blocked', drafted: 'Saved a Slack reply draft', 'dry-run': 'Dry run',
    declined: 'You decided not to do it'
  };
  const WHOSE = { you: 'Needs you', agent: 'Agent working', closed: 'Closed' };
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
    if (e.link) {
      li.append(document.createTextNode(' '), link(e.link.url, e.link.title));
      return li;
    }
    const text = e.text.replace(/^ease-\d+ \((live|dry-run)\)$/, '$1 run');
    if (text) li.append(document.createTextNode(`: ${text}`));
    return li;
  }
  const filing = new Set();
  // One POST per click; `ask` returns the request body, or null to cancel.
  function decisionButton(ts, { label, busy, path, ask, done }) {
    const button = el('button', filing.has(ts) ? busy : label, 'secondary ease-file-button');
    button.type = 'button';
    button.disabled = filing.has(ts);
    const status = el('span', null, 'ease-muted');
    status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      const extra = ask();
      if (!extra) return;
      filing.add(ts);
      button.disabled = true;
      button.textContent = busy;
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
          body: JSON.stringify({ ts, ...extra })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
        filing.delete(ts);
        await load();
        done?.(body);
      } catch (error) {
        filing.delete(ts);
        button.disabled = false;
        button.textContent = label;
        status.textContent = ` ${error.message}`;
        status.className = 'ease-error';
      }
    });
    return [button, status];
  }
  function decideButtons(a, ts) {
    const wrap = el('span', null, 'ease-file');
    if (a.ticket) {
      wrap.append(...decisionButton(ts, {
        label: 'File ticket as drafted', busy: 'Filing…', path: '/api/ease/file',
        ask: () => confirm('File this ticket in gobranch/branch as you, exactly as drafted?') && {},
        done: (body) => body.warning && alert(`Filed #${body.number}. ${body.warning}`)
      }));
    }
    wrap.append(...decisionButton(ts, {
      label: 'Not doing it', busy: 'Saving…', path: '/api/ease/decline',
      ask: () => {
        const reason = prompt('Not doing this one. Why? (optional, shown on this card)');
        return reason === null ? null : { reason };
      }
    }));
    return wrap;
  }
  function actionLeaf(a, ts) {
    const li = el('li', null, `ease-leaf ease-action ease-${a.state}`);
    li.append(el('span', { open: 'To do', done: 'Done', waiting: 'Agent', unknown: 'Check' }[a.state], 'ease-state'));
    li.append(a.url ? link(a.url, a.text) : el('span', a.text));
    if (a.state === 'unknown') li.append(el('span', ' (sent status isn’t tracked)', 'ease-muted'));
    if (a.decide) li.append(decideButtons(a, ts));
    if (a.ticket) {
      const d = el('details', null, 'ease-draft');
      d.append(el('summary', 'Preview what will be filed'), el('p', 'Title', 'ease-preview-label'), el('pre', a.ticket.title),
        el('p', 'Body', 'ease-preview-label'), el('pre', a.ticket.body));
      li.append(d);
    } else if (a.draft) {
      const d = el('details', null, 'ease-draft');
      d.append(el('summary', 'Read the draft (no fileable ticket section found)'), el('pre', a.draft));
      li.append(d);
    }
    return li;
  }
  const VERDICTS = { easy: 'Easy win', 'not-easy': 'Not easy', skipped: 'Skipped' };
  function summaryLine(p) {
    const { requester, verdict, reason, replyDraft } = p.summary || {};
    if (!verdict && !requester && !replyDraft) return null;
    const row = el('p', null, 'ease-facts');
    if (verdict) row.append(el('span', VERDICTS[verdict], `ease-verdict ease-verdict-${verdict}`));
    if (reason) row.append(document.createTextNode(` ${reason}`));
    const meta = [requester && `Requested by ${requester}`, replyDraft && 'Slack reply: draft saved (sent status isn’t tracked)'].filter(Boolean);
    if (meta.length) row.append(el('span', meta.join(' · '), 'ease-muted ease-facts-meta'));
    return row;
  }
  function post(p) {
    const li = el('li', null, `ease-post ease-${p.whose}`);
    const d = el('details');
    d.open = open.has(p.ts) ? open.get(p.ts) : p.whose === 'you';
    d.addEventListener('toggle', () => open.set(p.ts, d.open));
    const s = el('summary');
    s.append(el('span', WHOSE[p.whose], 'ease-badge'), el('span', p.title, 'ease-title'));
    s.append(el('span', [p.priority, time(p.updatedAt)].filter(Boolean).join(' · '), 'ease-muted'));
    const facts = summaryLine(p);
    const tree = el('ul', null, 'ease-tree');
    const you = p.actions.length ? p.actions.map((a) => actionLeaf(a, p.ts)) : [el('li', 'Nothing for you', 'ease-leaf ease-muted')];
    tree.append(branch('Agent', 'ease-agent', p.events.map(eventLeaf)), branch('You', 'ease-you', you));
    const foot = el('p', null, 'ease-muted ease-foot');
    foot.append(link(p.link, 'Slack post'));
    if (p.workspace) foot.append(document.createTextNode(` · Workspace “${p.workspace.name}”${p.workspace.comment ? ` · ${p.workspace.comment}` : ''}`));
    d.append(s, ...(facts ? [facts] : []), tree, foot);
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
