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
  if (s.pr) {
    const label = 'PR #' + s.pr.number + (s.pr.state && s.pr.state !== 'OPEN' ? ' (' + s.pr.state.toLowerCase() + ')' : '');
    chips.appendChild(chip(label, () => vscode.postMessage({ type: 'open-url', url: s.pr.url })));
  }
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
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) card.appendChild(el('div', 'meta', meta));
  if (c.overdue) card.appendChild(el('div', 'warn-line', '⚠ missed today'));

  const chips = el('div', 'chips');
  if (c.log) chips.appendChild(chip('log', () => vscode.postMessage({ type: 'open-file', path: c.log }), true));
  if (c.inbox) chips.appendChild(chip('inbox', () => vscode.postMessage({ type: 'reveal', path: c.inbox }), true));
  if (c.count) {
    chips.appendChild(
      chip('✓ mark reviewed', () => vscode.postMessage({ type: 'mark-reviewed', label: c.label, inbox: c.inbox }))
    );
  }
  card.appendChild(chips);
  return card;
}

function section(name, items, build, emptyText) {
  const sec = el('div', 'section');
  const header = el('div', 'section-header', name);
  header.appendChild(el('span', 'count', String(items.length)));
  sec.appendChild(header);
  if (!items.length) sec.appendChild(el('div', 'empty', emptyText));
  for (const item of items) sec.appendChild(build(item));
  return sec;
}

function render({ sessions, crons }) {
  app.textContent = '';
  app.appendChild(section('Sessions', sessions, sessionCard, 'no live sessions'));
  app.appendChild(section('Crons', crons, cronCard, 'no bots configured (panopticlaude.crons)'));
}
