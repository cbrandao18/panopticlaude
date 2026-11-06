// Sets the Roost theme and brand before first paint, on every page.
(function () {
  'use strict';
  const brand = {
    name: 'Roost',
    tagline: 'Where your agents check in.',
    // Coloured by the bird tokens (the bd-* classes in themes.css), perched on a short wire.
    mark: '<svg aria-hidden="true" viewBox="0 0 48 48"><path class="bd-tail" d="M13 30L2 37l13 1z"/><ellipse class="bd-body" cx="23" cy="29" rx="14" ry="11"/><circle class="bd-body" cx="32" cy="18" r="9"/><ellipse class="bd-belly" cx="28" cy="33" rx="8" ry="5.5"/><path class="bd-wing" d="M11 27c5-7 16-5 19 3-7 6-17 5-19-3z"/><path class="bd-beak" d="M40 16l7 3.5-7 3z"/><circle class="bd-eye" cx="35" cy="16" r="1.8"/><path class="bd-leg" d="M22 39v5M29 39v5M0 44.5Q24 49 48 44.5"/></svg>'
  };
  document.documentElement.dataset.theme = 'roost';
  window.pano = { brand: () => brand };
  document.addEventListener('DOMContentLoaded', () => {
    document.title = document.title.replace(/^[^·]*·/, `${brand.name} ·`);
    // Static pages (Work) mark their brand slots; the Preact pages read pano.brand() themselves.
    for (const node of document.querySelectorAll('[data-brand-name]')) node.textContent = brand.name;
    for (const node of document.querySelectorAll('[data-brand-mark]')) node.innerHTML = brand.mark;
  });
})();
