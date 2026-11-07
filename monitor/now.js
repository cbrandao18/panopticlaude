// The Now page: down, ready to ship, blocked on you, release watch, automations, brief. Read-only.
import { h, render } from './vendor/preact.js';
import { useEffect, useState } from './vendor/hooks.js';
import htm from './vendor/htm.js';
import { Masthead, openInOrca } from './ui.js';
import { Bird, Nest, StatusBird } from './roost.js';

const html = htm.bind(h);
const SHOWN = 5;

// 12-hour times read "1:38pm": lowercase am/pm, no space.
const meridiem = (text) => text.replace(/[\s ]*([AP])M\b/g, (m, l) => `${l.toLowerCase()}m`);
const clock = (ms) => (ms ? meridiem(new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : '');
const when = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ms) : meridiem(d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
};
const ago = (ms) => {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
};
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const hostLabel = (host) => (host === 'vm' ? 'VM' : 'Mac');


function usePoll(route, ms) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(route, { signal: AbortSignal.timeout(90000) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (alive) setState({ data, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: e.message || 'Couldn’t reach the dashboard server.' }));
      }
    };
    load();
    const timer = setInterval(load, ms);
    return () => { alive = false; clearInterval(timer); };
  }, [route, ms]);
  return state;
}

const Link = ({ href, children }) => (href ? html`<a href=${href}>${children}</a>` : children);

function More({ items, row }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return html`
    <ul class="rows">${shown.map(row)}</ul>
    ${items.length > SHOWN && html`<button class="text more" type="button" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${items.length}`}</button>`}`;
}

function Section({ id, title, count, tone, children, note, bird }) {
  return html`
    <section class=${`tier ${tone || ''}`} aria-labelledby=${`${id}-title`}>
      <header class="tier-head">
        <h2 id=${`${id}-title`}>${title}${count != null && html` <span class="count">${count}</span>`}</h2>
        ${note && html`<span class="now-muted">${note}</span>`}
      </header>
      ${bird && html`<span class="sect-bird"><${Bird} state=${bird} /></span>`}
      ${children}
    </section>`;
}

function Down({ data }) {
  const { down, vendors, automations } = data;
  const vendorPills = html`
    <ul class="pills" aria-label="Status pages">
      ${vendors.map((v) => html`<li key=${v.name} class=${v.ok ? 'ok' : 'bad'} title=${v.detail || 'OK'}><${Link} href=${v.url}>${v.name}</${Link}></li>`)}
      ${data.unwatched.map((name) => html`<li key=${name} class="none" title="Nothing watches this yet">${name}</li>`)}
    </ul>`;
  if (!down.length) {
    return html`
      <section class="tier calm" aria-label="Down">
        <header class="tier-head" aria-hidden="true"><h2>Down</h2></header>
        <span class="sect-bird"><${Bird} state="ok" /></span>
        <p><span class="dot ok" aria-hidden="true"></span><strong>Nothing is down.</strong>
        <span class="now-muted"> ${vendors.length} vendors, ${automations.length} automations and the bug sweep checked at ${clock(data.refreshedAt)}.</span></p>
        ${vendorPills}
      </section>`;
  }
  return html`
    <${Section} id="down" title="Down" count=${down.length} tone="alarm" bird="failed">
      <${More} items=${down} row=${(d, i) => html`
        <li key=${`${d.kind}${i}${d.title}`}>
          <${Bird} state="failed" />
          <span class=${`chip ${d.kind}`}>${{ vendor: 'Status', automation: 'Automation', sweep: 'Bug sweep', error: 'Prod error' }[d.kind] || d.kind}</span>
          <span class="title"><${Link} href=${d.url}>${d.title}</${Link}></span>
          ${d.detail && html`<span class="detail">${d.detail}</span>`}
          ${d.since && html`<span class="when">${ago(d.since)}</span>`}
        </li>`} />
      ${vendorPills}
    </${Section}>`;
}

function Ready({ data }) {
  const { ready, waitingPrs } = data;
  return html`
    <${Section} id="ship" title="Ready to ship" count=${ready.length} tone=${ready.length ? 'go' : ''}
      note=${waitingPrs.length ? `${waitingPrs.length} more of your PRs are waiting on something` : ''}>
      ${ready.length
        ? html`<${More} items=${ready} row=${(pr) => html`
            <li key=${pr.number}>
              ${pr.fix && html`<span class="chip fix">Fix</span>`}
              <span class="title"><a href=${pr.url}>#${pr.number} ${pr.title}</a></span>
              ${pr.unstable && html`<span class="detail">an optional check is failing</span>`}
            </li>`} />`
        : html`<p class="now-muted empty-nest"><${Nest} eggs=${0} />None of your PRs can merge right now.</p>`}
      ${ready.length > 0 && html`<${Nest} eggs=${ready.length} />`}
    </${Section}>`;
}

function Group({ label, items, row, empty }) {
  return html`
    <div class="group">
      <h3>${label} <span class="count">${items.length}</span></h3>
      ${items.length ? html`<${More} items=${items} row=${row} />` : html`<p class="now-muted empty"><${Bird} state="idle" />${empty}</p>`}
    </div>`;
}

function Blocked({ data }) {
  const { agents, reviews, ease, drafts } = data.blocked;
  const total = agents.length + reviews.length + ease.length + drafts.length;
  return html`
    <${Section} id="blocked" title="Blocked on you" count=${total} tone=${total ? 'you' : ''} bird=${total ? 'you' : ''}>
      <div class="groups">
        <${Group} label="Agents waiting" items=${agents} empty="No agent is waiting on you."
          row=${(a) => html`<li key=${a.key}><span class="presence you" aria-hidden="true"></span><${Bird} state="you" /><span class="title">${a.ask}</span><span class="detail">${a.name} · ${hostLabel(a.host)}${a.pr ? html` · <a href=${a.pr.url}>PR #${a.pr.number}</a>` : ''}</span>
            <button class="text open" type="button" onClick=${() => openInOrca(a.key, a.name)}>Open in Orca</button></li>`} />
        <${Group} label="Reviews requested" items=${reviews} empty="No reviews requested."
          row=${(r) => html`<li key=${r.url}><span class="title"><a href=${r.url}>#${r.number} ${r.title}</a> <span class="detail">· ${r.author}</span></span></li>`} />
        <${Group} label="Ease decisions" items=${ease} empty="No Ease & effort post needs you."
          row=${(e) => html`<li key=${e.link || e.title}><span class="title"><${Link} href=${e.nextUrl}>${e.next}</${Link}></span><span class="detail"><${Link} href=${e.link}>${e.title}</${Link}></span></li>`} />
        <${Group} label="Held drafts" items=${drafts} empty="No unread assess-assumptions drafts."
          row=${(d) => html`<li key=${d.name}><span class="title"><a href="/work#jobs">${d.name}</a></span><span class="detail">${d.unread} unread</span></li>`} />
      </div>
    </${Section}>`;
}

// A release's own `spark` count, or the feedback watcher's total.
const nightTotal = (r, n) => (r.spark ? n.counts?.[r.spark] || 0 : n.fixes + n.design + n.vague);

function Spark({ release }) {
  const last = release.nights.slice(-14);
  const w = 120;
  // Keep the column when there's no line yet, so every row's detail lines up.
  if (last.length < 2) return html`<svg class="spark" viewBox="0 0 ${w} 24" width=${w} height="24" aria-hidden="true"></svg>`;
  const total = (n) => nightTotal(release, n);
  const max = Math.max(1, ...last.map(total));
  const step = w / (last.length - 1);
  const points = last.map((n, i) => `${(i * step).toFixed(1)},${(22 - (total(n) / max) * 20).toFixed(1)}`).join(' ');
  return html`<svg class="spark" viewBox="0 0 ${w} 24" width=${w} height="24" role="img" aria-label="${release.spark ? release.metrics.find(([k]) => k === release.spark)?.[1] || release.spark : 'Feedback'}, last ${last.length} entries"><polyline points=${points} /></svg>`;
}

function Releases({ data }) {
  return html`
    <${Section} id="releases" title="Release watch" tone="info" note="Weeks, not hours. Signal: what each project's watcher logs, nightly or weekly.">
      <ul class="rows releases">
        ${data.releases.map((r) => html`
          <li key=${r.name}>
            <span class="title">${r.url ? html`<${Link} href=${r.url}>${r.name}</${Link}>` : r.name}</span>
            <${Spark} release=${r} />
            <span class="detail">
              ${r.last
                ? r.last.failed
                  ? `Watcher failed ${day(r.last.date)}`
                  : r.metrics
                    ? `${day(r.last.date)}: ${r.metrics.map(([key, label]) => `${r.last.counts?.[key] ?? 0} ${label}`).join(', ')}`
                    : html`${day(r.last.date)}: ${r.last.fixes} fixes, ${r.last.design} design calls, ${r.last.vague} vague${r.last.ticket ? html` → <a href=${`https://github.com/gobranch/branch/issues/${r.last.ticket}`}>#${r.last.ticket}</a>` : ''}`
                : `No nights logged yet in ${r.channel}`}
            </span>
            ${r.epic && html`<span class="epic"><a href=${r.epic.url}>#${r.epic.number}</a> ${r.epic.completed} of ${r.epic.total} done
              <meter min="0" max=${r.epic.total || 1} value=${r.epic.completed}></meter></span>`}
          </li>`)}
      </ul>
    </${Section}>`;
}

const STATUS = { failed: 'Failed', overdue: 'Missed run', unreadable: 'Unreadable', running: 'Running', completed: 'Run finished', paused: 'Paused', waiting: 'Not run yet', skipped: 'Skipped', cancelled: 'Stopped' };

function Automations({ data }) {
  const [showPaused, setShowPaused] = useState(false);
  const rows = data.automations.filter((a) => showPaused || a.status !== 'paused');
  const paused = data.automations.length - data.automations.filter((a) => a.status !== 'paused').length;
  return html`
    <${Section} id="automations" title="Automations" tone="lilac" count=${rows.length}
      note=${html`Run finished means Orca marked it complete, not that the work succeeded. <a href="/work#jobs">Logs</a>`}>
      <table class="autos">
        <thead><tr><th scope="col">Status</th><th scope="col">Automation</th><th scope="col">Where</th><th scope="col">Last run</th><th scope="col">Next run</th></tr></thead>
        <tbody>
          ${rows.map((a) => html`
            <tr key=${a.key} class=${a.status}>
              <td><span class=${`dot ${a.status}`} aria-hidden="true"></span><${StatusBird} status=${a.status} />${STATUS[a.status] || a.status}</td>
              <td>${a.name}${a.error && html`<div class="detail">${a.error}</div>`}</td>
              <td>${hostLabel(a.host)}</td>
              <td>${a.lastRunAt ? ago(a.lastRunAt) : '—'}</td>
              <td>${a.nextRunAt ? when(a.nextRunAt) : '—'}</td>
            </tr>`)}
        </tbody>
      </table>
      ${paused > 0 && html`<button class="text more" type="button" onClick=${() => setShowPaused(!showPaused)}>${showPaused ? 'Hide paused' : `Show ${paused} paused`}</button>`}
    </${Section}>`;
}

function Brief() {
  const { data } = usePoll('/api/brief', 300000);
  if (!data) return null;
  return html`
    <details class="tier brief">
      <summary><h2>Daily brief</h2><span class="now-muted">${data.error || (data.writtenAt ? `Written ${when(data.writtenAt)} on the VM` : 'No brief yet')}</span></summary>
      ${data.html && html`<div class="brief-body" dangerouslySetInnerHTML=${{ __html: data.html }} />`}
    </details>`;
}

function App() {
  const { data, error } = usePoll('/api/now', 60000);
  return html`
    <${Masthead} page="/" status=${error ? `Couldn't refresh: ${error}` : data ? `Updated ${clock(data.refreshedAt)}` : 'Checking everything…'} />
    ${data && html`
      <${Down} data=${data} />
      <${Ready} data=${data} />
      <${Blocked} data=${data} />
      <${Releases} data=${data} />
      <${Automations} data=${data} />
      <${Brief} />
      ${data.errors.length > 0 && html`<footer class="errors"><strong>Couldn't read:</strong> ${data.errors.map((e) => `${e.source} (${e.error})`).join(' · ')}</footer>`}`}`;
}

const root = document.getElementById('app');
root.replaceChildren();
render(html`<${App} />`, root);
