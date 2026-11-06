/* Ready to merge: Christie's non-draft PRs GitHub would merge now without a bypass. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('merge');
  if (!root) return;
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
  const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);
  let waitingOpen = false;

  function row(pr, note) {
    const li = el('li', null, 'merge-row');
    li.append(link(pr.url, `#${pr.number}`), document.createTextNode(` ${pr.title}`));
    if (note) li.append(el('span', ` · ${note}`, 'merge-muted'));
    return li;
  }
  function render(data) {
    const ready = data.ready || [];
    const waiting = data.waiting || [];
    const head = el('div', null, 'merge-head');
    head.append(el('h2', 'Ready to merge'), el('span', `${ready.length} ready · ${waiting.length} waiting · updated ${time(data.refreshedAt)}`, 'merge-muted'));
    const parts = [head];
    if (data.error) parts.push(el('p', data.error, 'merge-error'));
    if (ready.length) {
      const list = el('ul', null, 'merge-list');
      list.append(...ready.map((pr) => row(pr, pr.unstable ? 'a non-required check is failing' : '')));
      parts.push(list);
    } else if (!data.error) {
      parts.push(el('p', 'None of your ready-for-review PRs can merge without a bypass right now.', 'merge-muted'));
    }
    if (waiting.length) {
      const d = el('details', null, 'merge-waiting');
      d.open = waitingOpen;
      d.addEventListener('toggle', () => { waitingOpen = d.open; });
      d.append(el('summary', `${waiting.length} waiting`));
      const list = el('ul', null, 'merge-list');
      list.append(...waiting.map((pr) => row(pr, pr.reason)));
      d.append(list);
      parts.push(d);
    }
    root.replaceChildren(...parts);
  }
  async function load() {
    try {
      const res = await fetch('/api/merge');
      render(await res.json());
    } catch {
      render({ refreshedAt: Date.now(), error: 'Couldn’t reach the dashboard server.' });
    }
  }
  load();
  setInterval(load, 120000);
})();
