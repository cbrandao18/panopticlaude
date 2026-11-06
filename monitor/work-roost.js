// The Work page's static masthead gets the shared Roost sprite and wire.
import { h, render } from './vendor/preact.js';
import { Branch, Sprite } from './roost.js';

render(h(Sprite), document.getElementById('roost-sprite'));
render(h(Branch), document.getElementById('roost-wire'));
