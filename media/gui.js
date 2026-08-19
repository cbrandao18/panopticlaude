// Renders the mission-control cards from data pushed by the extension.
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'data') render(e.data);
});
vscode.postMessage({ type: 'ready' });

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function chip(label, onClick, action) {
  const b = el('button', 'chip' + (action ? ' action' : ''), label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function sessionCard(s) {
  const card = el('div', 'card');
  card.title = s.workCwd + '\npid ' + s.pid;
  card.addEventListener('click', () =>
    vscode.postMessage({ type: 'open-session', sessionId: s.sessionId, transcript: s.transcript })
  );

  const row1 = el('div', 'row1');
  row1.appendChild(el('span', 'dot ' + s.display));
  row1.appendChild(el('span', 'title', s.label));
  if (s.word) row1.appendChild(el('span', 'pill ' + s.display, s.word + (s.ageStr ? ' · ' + s.ageStr : '')));
  if (s.edited) row1.appendChild(el('span', 'pill edits', '✎ ' + s.edited));
  card.appendChild(row1);

  const meta = [s.model, s.effort, s.branch].filter(Boolean).join(' · ');
  if (meta) card.appendChild(el('div', 'meta', meta));

  if (s.pct != null) {
    const ctx = el('div', 'ctx');
    const bar = el('div', 'ctx-bar');
    const fill = el('div', 'ctx-fill' + (s.pct >= 80 ? ' hot' : ''));
    fill.style.width = Math.max(2, s.pct) + '%';
    bar.appendChild(fill);
    ctx.appendChild(bar);
    ctx.appendChild(el('span', 'ctx-label', s.pct + '%' + (s.pct >= 80 ? ' ⚠' : '')));
    card.appendChild(ctx);
  }

  const chips = el('div', 'chips');
  if (s.issueUrl) chips.appendChild(chip('#' + s.issueNum, () => vscode.postMessage({ type: 'open-url', url: s.issueUrl })));
  if (s.pr) chips.appendChild(chip(s.prLabel, () => vscode.postMessage({ type: 'open-url', url: s.pr.url })));
  chips.appendChild(chip('transcript', () => vscode.postMessage({ type: 'open-file', path: s.transcript }), true));
  card.appendChild(chips);
  return card;
}

function cronCard(c) {
  const card = el('div', 'card static');
  card.title = c.label;
  const bad = c.exit != null && c.exit !== '0' && c.exit !== 'never-exited';
  const dotClass = bad ? 'bad' : c.overdue ? 'overdue' : c.count ? 'inboxful' : 'ok';

  const row1 = el('div', 'row1');
  row1.appendChild(el('span', 'dot ' + dotClass));
  row1.appendChild(el('span', 'title', c.shortLabel));
  if (c.count) row1.appendChild(el('span', 'pill question', c.count + ' new'));
  card.appendChild(row1);

  const meta = [
    c.schedule ? '@' + c.schedule : null,
    c.exit != null && c.exit !== 'never-exited' ? 'exit ' + c.exit : null,
    c.ranAgo ? 'ran ' + c.ranAgo : null,
    c.nextIn ? 'next in ' + c.nextIn : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) card.appendChild(el('div', 'meta', meta));
  if (c.overdue) card.appendChild(el('div', 'warn-line', '⚠ missed today'));

  const chips = el('div', 'chips');
  if (c.log) chips.appendChild(chip('log', () => vscode.postMessage({ type: 'open-file', path: c.log }), true));
  if (c.inbox) chips.appendChild(chip('inbox', () => vscode.postMessage({ type: 'reveal', path: c.inbox }), true));
  if (c.inbox)
    chips.appendChild(chip("today's draft", () => vscode.postMessage({ type: 'open-today-draft', inbox: c.inbox }), true));
  if (c.inbox && c.repo)
    chips.appendChild(
      chip('post drafts…', () => vscode.postMessage({ type: 'post-drafts', inbox: c.inbox, repo: c.repo }))
    );
  if (c.count) {
    chips.appendChild(
      chip('✓ mark reviewed', () => vscode.postMessage({ type: 'mark-reviewed', label: c.label, inbox: c.inbox }))
    );
  }
  card.appendChild(chips);
  return card;
}

function prCard(p) {
  const card = el('div', 'card');
  card.title = p.url;
  card.addEventListener('click', () => vscode.postMessage({ type: 'open-url', url: p.url }));
  const dotClass = p.status === 'bad' ? 'bad' : p.status === 'good' ? 'ok' : 'waiting';

  const row1 = el('div', 'row1');
  row1.appendChild(el('span', 'dot ' + dotClass));
  row1.appendChild(el('span', 'title', p.title));
  card.appendChild(row1);
  card.appendChild(el('div', 'meta', p.desc));
  return card;
}

function worktreeCard(w) {
  const card = el('div', 'card');
  card.title = w.path;
  card.addEventListener('click', () => vscode.postMessage({ type: 'open-folder', path: w.path }));

  const row1 = el('div', 'row1');
  row1.appendChild(el('span', 'dot ' + (w.prunable ? 'overdue' : w.dirty ? 'inboxful' : 'idle')));
  row1.appendChild(el('span', 'title', w.name));
  card.appendChild(row1);
  if (w.desc) card.appendChild(el('div', 'meta', w.desc));
  if (w.prunable) card.appendChild(el('div', 'warn-line', '⚠ PRUNABLE'));
  return card;
}

// Collapse state persists via the webview's own state store (survives the 5s
// re-renders and view reloads). Worktrees starts collapsed: it's the long one.
function getCollapsed() {
  const s = vscode.getState();
  return new Set((s && s.collapsed) || ['Worktrees']);
}

function toggleSection(name) {
  const c = getCollapsed();
  if (c.has(name)) c.delete(name);
  else c.add(name);
  vscode.setState({ ...(vscode.getState() || {}), collapsed: [...c] });
  if (lastData) render(lastData);
}

function section(name, items, build, emptyText, headerExtra) {
  const sec = el('div', 'section');
  const isCollapsed = getCollapsed().has(name);
  const header = el('div', 'section-header');
  header.appendChild(el('span', 'chev', isCollapsed ? '▸' : '▾'));
  header.appendChild(el('span', null, name));
  header.appendChild(el('span', 'count', String(items.length)));
  if (headerExtra) header.appendChild(headerExtra);
  header.addEventListener('click', () => toggleSection(name));
  sec.appendChild(header);
  if (!isCollapsed) {
    if (!items.length) sec.appendChild(el('div', 'empty', emptyText));
    for (const item of items) sec.appendChild(build(item));
  }
  return sec;
}

let lastData = null;

function render(data) {
  lastData = data;
  const { sessions, prs, worktrees, crons } = data;
  app.textContent = '';
  app.appendChild(section('Sessions', sessions, sessionCard, 'no live sessions'));
  app.appendChild(section('My PRs', prs || [], prCard, 'no open PRs (panopticlaude.repos)'));
  const cleanBtn = chip('clean up…', () => vscode.postMessage({ type: 'clean-worktrees' }), true);
  app.appendChild(section('Worktrees', worktrees || [], worktreeCard, 'no worktrees (panopticlaude.repos)', cleanBtn));
  app.appendChild(section('Crons', crons, cronCard, 'no bots configured (panopticlaude.crons)'));
}
