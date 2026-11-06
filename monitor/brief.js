/* The daily brief from the VM, at the top of the page. Read-only. */
(function () {
  'use strict';
  const root = document.getElementById('brief');
  if (!root) return;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const time = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    .replace(/[\s ]*([AP])M$/, (m, l) => `${l.toLowerCase()}m`);
  // Links open in the Mac's default browser through the server; falls back to a new tab.
  root.addEventListener('click', async (event) => {
    const a = event.target.closest('a[href^="http"]');
    if (!a) return;
    event.preventDefault();
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
        body: JSON.stringify({ url: a.href })
      });
      if (!res.ok) throw new Error();
    } catch {
      window.open(a.href, '_blank', 'noreferrer');
    }
  });

  function render(data) {
    const note = el('p', null, 'brief-muted');
    if (data.error) note.textContent = data.error;
    else if (!data.html) note.textContent = 'No brief yet. It runs weekdays at 8:45am and 1:30pm on the VM.';
    else note.textContent = `Written ${data.writtenAt ? time(data.writtenAt) : 'at an unknown time'} on the VM. The same brief goes to you as a Slack DM.`;
    const body = el('div', null, 'brief-body');
    // GitHub's markdown API returns sanitized HTML.
    if (data.html) body.innerHTML = data.html;
    root.replaceChildren(body, note);
  }
  async function load() {
    try {
      render(await (await fetch('/api/brief')).json());
    } catch {
      render({ error: 'Couldn’t reach the dashboard server.' });
    }
  }
  load();
  setInterval(load, 60000);
})();
