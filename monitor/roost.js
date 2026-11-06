// Roost's birds, egg, nest and branch. One inline SVG sprite; colours come from CSS tokens in themes.css.
// Everything here is decoration: it is aria-hidden and hidden unless a Roost theme is on.
import { h } from './vendor/preact.js';
import htm from './vendor/htm.js';

const html = htm.bind(h);

export const SPRITE = `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    <symbol id="b-perch" viewBox="0 0 48 48">
      <path class="bd-tail" d="M13 30 L2 37 L15 38Z"/>
      <ellipse class="bd-body" cx="23" cy="29" rx="14" ry="11"/>
      <circle class="bd-body" cx="32" cy="18" r="9"/>
      <ellipse class="bd-belly" cx="28" cy="33" rx="8" ry="5.5"/>
      <path class="bd-wing" d="M11 27 C16 20 27 22 30 30 C23 36 13 35 11 27Z"/>
      <path class="bd-beak" d="M40 16 L47 19.5 L40 22.5Z"/>
      <circle class="bd-eye" cx="35" cy="16" r="1.8"/>
      <path class="bd-leg" d="M22 39v6M29 39v6"/>
    </symbol>
    <symbol id="b-fly" viewBox="0 0 48 48">
      <path class="bd-tail" d="M14 30 L2 31 L13 36Z"/>
      <path class="bd-wing back" d="M20 27 C19 17 11 10 4 11 C7 19 12 26 19 30Z"/>
      <ellipse class="bd-body" cx="24" cy="29" rx="13" ry="8.5" transform="rotate(-12 24 29)"/>
      <circle class="bd-body" cx="35" cy="24" r="7.5"/>
      <ellipse class="bd-belly" cx="27" cy="33" rx="7" ry="3.8" transform="rotate(-12 27 33)"/>
      <path class="bd-wing" d="M19 27 C15 15 22 5 33 3 C32 12 31 20 29 28Z"/>
      <path class="bd-beak" d="M41 22 L47.5 25 L41 28Z"/>
      <circle class="bd-eye" cx="37.5" cy="22.5" r="1.7"/>
    </symbol>
    <symbol id="b-call" viewBox="0 0 48 48">
      <path class="bd-tail" d="M10 31 L1 40 L13 38Z"/>
      <ellipse class="bd-body" cx="20" cy="30" rx="13" ry="11" transform="rotate(-10 20 30)"/>
      <circle class="bd-body" cx="28" cy="17" r="9"/>
      <ellipse class="bd-belly" cx="25" cy="34" rx="7.5" ry="5.5"/>
      <path class="bd-wing" d="M9 28 C14 21 24 23 27 31 C20 37 11 36 9 28Z"/>
      <path class="bd-beak" d="M35 11 L42.5 8 L36.5 15.5Z"/>
      <path class="bd-beak" d="M36 16 L43 17.5 L36.5 20Z"/>
      <circle class="bd-eye" cx="31" cy="14.5" r="1.8"/>
      <path class="bd-sound" d="M43 1.5 Q47 5 45 9M39 0.5 Q42 3 41 6"/>
      <path class="bd-leg" d="M19 40v5M26 40v5"/>
    </symbol>
    <symbol id="b-sleep" viewBox="0 0 48 48">
      <path class="bd-tail" d="M9 33 L1 40 L13 40Z"/>
      <ellipse class="bd-body" cx="24" cy="31" rx="17" ry="12"/>
      <circle class="bd-body" cx="32" cy="23" r="8"/>
      <path class="bd-wing" d="M10 30 C16 22 29 25 32 34 C24 40 12 38 10 30Z"/>
      <path class="bd-beak" d="M38.5 24 L44 26.5 L38 28.5Z"/>
      <path class="bd-eyeline" d="M30.5 22.5 q2 2 4 0"/>
      <path class="bd-leg" d="M22 42v4M29 42v4"/>
      <path class="bd-z" d="M35 8h5l-5 6h5M42 1h3.5l-3.5 4.3h3.5"/>
    </symbol>
    <symbol id="b-stuck" viewBox="0 0 48 48">
      <path class="bd-tail" d="M13 30 L2 37 L15 38Z"/>
      <ellipse class="bd-body" cx="23" cy="30" rx="14" ry="11"/>
      <circle class="bd-body" cx="31" cy="21" r="9"/>
      <ellipse class="bd-belly" cx="28" cy="34" rx="8" ry="5.5"/>
      <path class="bd-wing" d="M11 28 C16 21 27 23 30 31 C23 37 13 36 11 28Z"/>
      <path class="bd-beak" d="M39 20 L46 23.5 L39 26.5Z"/>
      <circle class="bd-eye" cx="34" cy="19" r="1.8"/>
      <path class="bd-leg" d="M22 40v5M29 40v5"/>
      <circle class="bd-dot" cx="30" cy="5" r="2.2"/><circle class="bd-dot" cx="37" cy="5" r="2.2"/><circle class="bd-dot" cx="44" cy="5" r="2.2"/>
    </symbol>
    <symbol id="b-fail" viewBox="0 0 48 48">
      <path class="bd-tail" d="M13 30 L2 37 L15 38Z"/>
      <ellipse class="bd-body" cx="23" cy="29" rx="14" ry="11"/>
      <circle class="bd-body" cx="32" cy="18" r="9"/>
      <path class="bd-body" d="M26 11 L27 3 L31 9 L34 2 L36 9 L41 5 L39 12Z"/>
      <ellipse class="bd-belly" cx="28" cy="33" rx="8" ry="5.5"/>
      <path class="bd-wing" d="M11 27 C16 20 27 22 30 30 C23 36 13 35 11 27Z"/>
      <path class="bd-beak" d="M40 17 L47 20.5 L40 23.5Z"/>
      <path class="bd-x" d="M32.5 14.5l4 4M36.5 14.5l-4 4"/>
      <path class="bd-leg" d="M22 39v6M29 39v6"/>
    </symbol>
    <symbol id="egg" viewBox="0 0 48 48">
      <path class="eg-shell" d="M24 4 C33 4 39 19 39 29 C39 38 32 44 24 44 C16 44 9 38 9 29 C9 19 15 4 24 4Z"/>
      <path class="eg-spot" d="M19 20a2 2 0 1 0 .1 0M29 27a2.2 2.2 0 1 0 .1 0M20 35a1.8 1.8 0 1 0 .1 0M27 15a1.5 1.5 0 1 0 .1 0"/>
    </symbol>
    <symbol id="nest" viewBox="0 0 64 36">
      <path class="ns-back" d="M3 14 C4 28 16 33 32 33 C48 33 60 28 61 14"/>
      <path class="ns-twig" d="M2 16 Q22 26 40 18 M6 22 Q24 32 58 16 M10 27 Q30 22 54 26 M14 31 Q34 28 50 29 M4 12 Q14 22 30 24 M60 12 Q46 24 26 25"/>
    </symbol>
    <pattern id="branch-tile" width="260" height="30" patternUnits="userSpaceOnUse">
      <path class="br-twig" d="M-2 17 C30 9 60 22 100 15 S170 9 200 17 S240 22 262 17"/>
      <path class="br-twig" d="M96 16 q10 -9 22 -8 M180 14 q8 8 20 8"/>
      <path class="br-leaf" d="M60 17 q4 -12 16 -12 q0 12 -16 12Z"/>
      <path class="br-leaf" d="M130 14 q-3 11 -15 12 q-1 -11 15 -12Z"/>
      <path class="br-leaf" d="M222 17 q3 -11 15 -11 q1 11 -15 11Z"/>
      <circle class="br-berry" cx="118" cy="8" r="3.2"/><circle class="br-berry" cx="200" cy="22" r="3.2"/>
    </pattern>
  </defs>
</svg>
`;

// Pose by state: calling for you, flying while working, perched when calm, asleep when quiet.
const POSE = { you: 'b-call', failed: 'b-fail', stuck: 'b-stuck', working: 'b-fly', idle: 'b-perch', quiet: 'b-sleep' };

export const Sprite = () => html`<div class="sprite-host" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: SPRITE }} />`;

// state: you | failed | stuck | working | idle | quiet | ok
export const Bird = ({ state, size }) => html`<svg class=${`bird ${state} ${size || ''}`} aria-hidden="true"><use href=${`#${state === 'ok' ? 'b-perch' : POSE[state] || 'b-perch'}`} /></svg>`;
export const Egg = () => html`<svg class="egg" aria-hidden="true"><use href="#egg" /></svg>`;
// Perch and Dusk draw a leafy branch under the masthead; Roost draws a plain sagging wire.
export const Branch = () => html`
  <svg class="roost-branch" aria-hidden="true"><rect width="100%" height="100%" fill="url(#branch-tile)" /></svg>
  <svg class="masthead-wire" viewBox="0 0 1000 22" preserveAspectRatio="none" aria-hidden="true"><path class="wire-line" d="M0 4 Q500 28 1000 4" /></svg>`;

// A sagging wire with one bird per item, in the pose for its state. Hidden outside the Roost theme.
// states: array of bird states (you, failed, stuck, working, ok, idle, quiet); width is the drawing width, not pixels.
export function Wire({ states, width = 720, cap = 20, cls = '' }) {
  const size = 34, y0 = 36, sag = 12;
  const shown = states.slice(0, cap);
  const extra = states.length - shown.length;
  const room = width - 24 - size - (extra ? 44 : 0);
  const step = Math.min(size + 12, room / Math.max(shown.length - 1, 1));
  const curve = (x) => y0 + 4 * sag * (x / width) * (1 - x / width);
  return html`
    <svg class=${`wire ${cls}`} viewBox=${`0 0 ${width} ${shown.length ? 66 : 44}`} aria-hidden="true">
      <path class="wire-line" d=${`M0 ${y0} Q${width / 2} ${y0 + 2 * sag} ${width} ${y0}`} />
      ${shown.map((state, i) => {
        const x = 18 + i * step;
        const flip = i % 3 === 1;
        const y = curve(x + size / 2) - size * 0.93 + 1;
        return html`<g key=${i} class=${`b ${state}`} transform=${`translate(${flip ? x + size : x} ${y.toFixed(1)})${flip ? ' scale(-1 1)' : ''}`}><use href=${`#${state === 'ok' || state === 'idle' ? 'b-perch' : POSE[state]}`} width=${size} height=${size} /></g>`;
      })}
      ${extra > 0 && html`<text class="wire-more" x=${18 + (shown.length - 1) * step + size + 8} y=${curve(width - 40) - 4}>+${extra}</text>`}
    </svg>`;
}

// A nest with up to three eggs, one per ready PR.
export const Nest = ({ eggs }) => html`
  <svg class="nest" viewBox="0 0 64 44" aria-hidden="true">
    ${Array.from({ length: Math.min(eggs, 3) }, (_, i) => html`<use key=${i} href="#egg" x=${6 + i * 18} y=${-2 + (i === 1 ? -2 : 2)} width="24" height="24" />`)}
    <use href="#nest" y="8" width="64" height="36" />
  </svg>`;

// Automation status as a bird pose; "waiting" (not run yet) is an egg.
const AUTO = { failed: 'failed', unreadable: 'failed', overdue: 'stuck', running: 'working', completed: 'ok', paused: 'quiet', skipped: 'quiet', cancelled: 'quiet' };
export const StatusBird = ({ status }) => (status === 'waiting' ? html`<${Egg} />` : html`<${Bird} state=${AUTO[status] || 'idle'} />`);
