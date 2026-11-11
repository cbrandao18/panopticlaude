// Keep navigation identical on the static Work page and the Preact pages.
import { h, render } from './vendor/preact.js';
import { Sidebar } from './roost.js';

render(h(Sidebar, { page: '/work' }), document.getElementById('roost-sidebar'));
