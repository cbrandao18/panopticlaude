// One plan doc from process-updates/docs, rendered from markdown in the browser. Read-only.
import { h, render } from './vendor/preact.js';
import { useEffect, useState } from './vendor/hooks.js';
import htm from './vendor/htm.js';
import { marked } from './vendor/marked.js';
import { Masthead } from './ui.js';

const html = htm.bind(h);
const STATUS = { building: 'Building', approved: 'Approved', draft: 'Draft', 'on-hold': 'On hold', done: 'Done', superseded: 'Superseded' };
const file = new URLSearchParams(window.location.search).get('file') || '';

// Links to other docs open here too: relative ones, and absolute paths into process-updates/docs.
export function planHref(href, from) {
  const [target, hash = ''] = href.split('#');
  if (!/\.md$/.test(target)) return href;
  const inDocs = target.split('/process-updates/docs/')[1];
  if (inDocs) return `/plan?file=${encodeURIComponent(inDocs)}${hash && `#${hash}`}`;
  if (/^([a-z]+:|\/)/i.test(target)) return href;
  const resolved = new URL(target, `http://docs/${from}`).pathname.slice(1);
  return `/plan?file=${encodeURIComponent(resolved)}${hash && `#${hash}`}`;
}

marked.use({ walkTokens(token) { if (token.type === 'link') token.href = planHref(token.href, file); } });

function Plan() {
  const [state, setState] = useState({ doc: null, error: null });
  useEffect(() => {
    fetch(`/api/plan?file=${encodeURIComponent(file)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        document.title = `Roost · ${body.title || body.file}`;
        setState({ doc: body, error: null });
      })
      .catch((e) => setState({ doc: null, error: e.message }));
  }, []);
  const { doc, error } = state;
  return html`
    <${Masthead} page="/#plans" status=${error ? '' : doc ? doc.file : 'Loading…'} />
    <p><a href="/#plans">← All plans</a></p>
    ${error && html`<p class="warning">Couldn't open ${file || 'this plan'}: ${error}</p>`}
    ${doc && html`
      <article class="tier plan-doc">
        <p class="plan-meta">
          ${doc.status && html`<span class=${`chip plan-${doc.status}`}>${STATUS[doc.status] || doc.status}</span>`}
          ${doc.next && html`<span>Next: ${doc.next}</span>`}
          ${doc.replacedBy && html`<span>Replaced by <a href=${planHref(doc.replacedBy, doc.file)}>${doc.replacedBy.split('/').pop()}</a></span>`}
        </p>
        <div class="markdown" dangerouslySetInnerHTML=${{ __html: marked.parse(doc.markdown) }} />
      </article>`}`;
}

const root = document.getElementById('app');
root.replaceChildren();
render(html`<${Plan} />`, root);
