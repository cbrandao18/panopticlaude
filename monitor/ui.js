// Shared page heading and actions for Overview, focused views and Map.
import { h } from './vendor/preact.js';
import htm from './vendor/htm.js';
import { PAGES, Sidebar } from './roost.js';

const html = htm.bind(h);

export function Masthead({ page, status }) {
  const current = PAGES.find(item => item.href === page) || PAGES[0];
  return html`
    <${Sidebar} page=${current.href} />
    <header class="page-heading">
      <div><h1 tabindex="-1">${current.label}</h1><p>${current.description}</p></div>
      <span class="now-muted" role="status">${status}</span>
    </header>`;
}


const toast = document.createElement('p');
toast.className = 'toast';
toast.setAttribute('role', 'status');
toast.hidden = true;
document.body.append(toast);
let timer;
export function say(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { toast.hidden = true; }, 6000);
}

// Brings the Orca app to the workspace (Mac or VM) through the server.
export async function openInOrca(key, name) {
  try {
    const res = await fetch('/api/orca/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
      body: JSON.stringify({ key })
    });
    const body = await res.json();
    say(res.ok ? `Opened ${name} in Orca.` : body.error || `Couldn't open ${name}.`);
  } catch {
    say(`Couldn't reach the dashboard server to open ${name}.`);
  }
}

// Links open in the Mac's default browser through the server; falls back to a new tab.
document.addEventListener('click', async (event) => {
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
