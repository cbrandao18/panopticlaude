/* One Claude Code tip at a time, pulled from the installed CLI. */
(function () {
  'use strict';
  const root = document.getElementById('claude-tips');
  if (!root) return;
  fetch('/api/claude-tips').then((res) => (res.ok ? res.json() : null)).then((data) => {
    if (!data?.tips?.length) return;
    const { tips } = data;
    let i = Math.floor(Math.random() * tips.length);
    root.innerHTML = '<span class="tip-label">Claude Code tip</span><span class="tip-text" aria-live="polite"></span>' +
      '<span class="tip-meta"></span><button type="button" class="secondary">Next tip</button>';
    const show = () => {
      root.querySelector('.tip-text').textContent = tips[i].text;
      root.querySelector('.tip-meta').textContent = `${i + 1} of ${tips.length} · v${data.version}`;
    };
    root.querySelector('button').addEventListener('click', () => { i = (i + 1) % tips.length; show(); });
    show();
    root.hidden = false;
  }).catch(() => {});
})();
