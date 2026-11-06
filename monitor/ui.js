// Shared by the Now and Map pages.
import { h } from './vendor/preact.js';
import { useEffect, useState } from './vendor/hooks.js';
import htm from './vendor/htm.js';
import { Branch, Sprite } from './roost.js';

const html = htm.bind(h);

// The name and mark come from theme.js, which the picker can change at any time.
function useBrand() {
  const [brand, setBrand] = useState(window.pano.brand());
  useEffect(() => {
    const update = () => setBrand(window.pano.brand());
    window.addEventListener('pano:change', update);
    return () => window.removeEventListener('pano:change', update);
  }, []);
  return brand;
}

const PAGES = [['/', 'Now'], ['/map', 'Map'], ['/work', 'Work']];

export function Masthead({ page, status }) {
  const brand = useBrand();
  return html`
    <header class="masthead">
      <div class="brand" title=${brand.name}><span class="brand-mark" dangerouslySetInnerHTML=${{ __html: brand.mark }} /><span class="brand-name">${brand.name}</span></div>
      <nav class="tabs" aria-label="Pages">${PAGES.map(([href, label]) => html`<a href=${href} aria-current=${page === href ? 'page' : null}>${label}</a>`)}</nav>
      <span class="now-muted" role="status">${status}</span>
    </header>
    <${Sprite} />
    <${Branch} />
    <div class="wordmark"><strong>${brand.name}</strong><span class="now-muted">${brand.tagline}</span></div>`;
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
