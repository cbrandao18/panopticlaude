// Theme and name picker, shared by every page. Runs in <head> so the chosen theme applies before first paint.
// Pages opt in to theming with data-themable on <html>; the Work page keeps its original look but takes the name.
(function () {
  'use strict';
  const THEMES = { roost: 'Roost', perch: 'Roost Perch', dusk: 'Roost Dusk', lounge: 'Lounge', branch: 'Branch', classic: 'Classic' };
  const ROOST_THEMES = ['roost', 'perch', 'dusk'];
  // The Roost themes get a full-colour bird on a leafy branch; everything else gets the line mark.
  // Coloured by the theme's bird tokens (the bd-* classes in themes.css), perched on a short wire.
  const ROOST_MARK = '<svg aria-hidden="true" viewBox="0 0 48 48"><path class="bd-tail" d="M13 30L2 37l13 1z"/><ellipse class="bd-body" cx="23" cy="29" rx="14" ry="11"/><circle class="bd-body" cx="32" cy="18" r="9"/><ellipse class="bd-belly" cx="28" cy="33" rx="8" ry="5.5"/><path class="bd-wing" d="M11 27c5-7 16-5 19 3-7 6-17 5-19-3z"/><path class="bd-beak" d="M40 16l7 3.5-7 3z"/><circle class="bd-eye" cx="35" cy="16" r="1.8"/><path class="bd-leg" d="M22 39v5M29 39v5M0 44.5Q24 49 48 44.5"/></svg>';
  const svg = (body) => `<svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const BRANDS = {
    roost: {
      name: 'Roost',
      tagline: 'Where your agents check in.',
      mark: svg('<path d="M3 25h26"/><path d="M9 25c0-6 4.5-10 10-10 2.5 0 4.5 1.6 4.5 3.6l3.5 1-3.5 1c-.4 3-3 4.4-6.5 4.4"/><circle cx="20" cy="18" r="1"/><path d="M13 25v3M18 25v3"/>')
    },
    aviary: {
      name: 'Aviary',
      tagline: 'All your agents, in one place.',
      mark: svg('<path d="M5 28V15a11 11 0 0 1 22 0v13"/><path d="M3 28h26M16 1.5V4"/><path d="M8.5 25c0-5 3.3-8.5 7.5-8.5 2.3 0 4 1.5 4 3.3l3.3.9-3.3.9c-.6 2.3-3 3.4-5.8 3.4"/><path d="M8.5 25H14"/><circle cx="17.5" cy="19.6" r=".7"/>')
    },
    switchboard: {
      name: 'Switchboard',
      tagline: 'Every agent, one board. What needs you first.',
      mark: svg('<circle cx="16" cy="16" r="4"/><circle cx="6" cy="7" r="2.5"/><circle cx="26" cy="7" r="2.5"/><circle cx="6" cy="25" r="2.5"/><circle cx="26" cy="25" r="2.5"/><path d="M8 9l5 4.5M24 9l-5 4.5M8 23l5-4.5M24 23l-5-4.5"/>')
    },
    crew: {
      name: 'Crew',
      tagline: 'Your agents, and what they need from you.',
      mark: svg('<circle cx="10" cy="12" r="4"/><circle cx="22" cy="12" r="4"/><circle cx="16" cy="9" r="4"/><path d="M3 26c1-5 4-7 7-7M29 26c-1-5-4-7-7-7M9 27c1-5 4-8 7-8s6 3 7 8"/>')
    },
    herd: {
      name: 'Herd',
      tagline: 'Keep every agent moving.',
      mark: svg('<path d="M16 5c6 0 11 3.5 11 8s-5 8-11 8S5 17.5 5 13s5-8 11-8z"/><path d="M12 20c-2 3-2 5 0 7M20 21l4 6"/><circle cx="16" cy="13" r="2"/>')
    },
    crowsnest: {
      name: "Crow's Nest",
      tagline: 'See every agent from up top.',
      mark: svg('<path d="M16 7v21"/><path d="M9 12h14l-2 5H11z"/><path d="M6 28h20"/><path d="M19 4.5l2 1.6 2-1.6"/>')
    },
    murmuration: {
      name: 'Murmuration',
      tagline: 'Many agents, moving as one.',
      mark: svg('<path d="M5 20l1.5 1 1.5-1M9 14l1.5 1 1.5-1M14 10l1.5 1 1.5-1M20 9l1.5 1 1.5-1M25 12l1.5 1 1.5-1M13 17l1.5 1 1.5-1M19 15l1.5 1 1.5-1M11 23l1.5 1 1.5-1M17 21l1.5 1 1.5-1M23 19l1.5 1 1.5-1"/>')
    },
    kestrel: {
      name: 'Kestrel',
      tagline: 'Hovers over your agents and spots what needs you.',
      mark: svg('<path d="M3 12c5-1.5 9-.5 13 4 4-4.5 8-5.5 13-4"/><path d="M16 16v7"/><path d="M13 27l3-4 3 4"/><circle cx="16" cy="14" r="1.5"/>')
    },
    panopticlaude: {
      name: 'Panopticlaude',
      tagline: 'Mission control for Claude sessions.',
      mark: svg('<path d="M3 16s5-9 13-9 13 9 13 9-5 9-13 9S3 16 3 16Z"/><circle cx="16" cy="16" r="4"/>')
    }
  };
  const read = (key, fallback, options) => {
    try {
      const value = localStorage.getItem(key);
      return value in options ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const root = document.documentElement;
  const themable = root.hasAttribute('data-themable');
  const state = { theme: read('pano.theme', 'roost', THEMES), brand: read('pano.brand', 'roost', BRANDS) };
  // ?theme=branch&name=crew opens a variant directly (handy for comparing in two tabs). It isn't saved.
  const params = new URLSearchParams(location.search);
  if (params.get('theme') in THEMES) state.theme = params.get('theme');
  if (params.get('name') in BRANDS) state.brand = params.get('name');

  function apply() {
    if (themable) root.dataset.theme = state.theme;
    const brand = window.pano.brand();
    document.title = document.title.replace(/^[^·]*·/, `${brand.name} ·`);
    // Static pages mark their brand slots; the Preact pages listen for pano:change instead.
    for (const node of document.querySelectorAll('[data-brand-name]')) node.textContent = brand.name;
    for (const node of document.querySelectorAll('[data-brand-mark]')) node.innerHTML = brand.mark;
    window.dispatchEvent(new CustomEvent('pano:change'));
  }

  function set(kind, value) {
    state[kind] = value;
    try {
      localStorage.setItem(`pano.${kind}`, value);
    } catch {}
    apply();
  }

  function picker() {
    const box = document.createElement('details');
    box.className = 'switcher';
    const summary = document.createElement('summary');
    summary.textContent = 'Theme & name';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const group = (kind, legendText, options) => {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = legendText;
      fieldset.append(legend);
      for (const [value, label] of Object.entries(options)) {
        const row = document.createElement('label');
        const input = document.createElement('input');
        Object.assign(input, { type: 'radio', name: `pano-${kind}`, value, checked: state[kind] === value });
        input.addEventListener('change', () => set(kind, value));
        row.append(input, document.createTextNode(label));
        fieldset.append(row);
      }
      return fieldset;
    };
    if (themable) panel.append(group('theme', 'Theme', THEMES));
    panel.append(group('brand', 'Name', Object.fromEntries(Object.entries(BRANDS).map(([k, b]) => [k, b.name]))));
    box.append(summary, panel);
    document.body.append(box);
  }

  window.pano = {
    brand: () => (themable && state.brand === 'roost' && ROOST_THEMES.includes(state.theme) ? { ...BRANDS.roost, mark: ROOST_MARK } : BRANDS[state.brand]),
    theme: () => state.theme
  };
  if (themable) root.dataset.theme = state.theme;
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    picker();
  });
})();
