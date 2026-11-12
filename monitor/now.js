// Overview and focused views: health, ready to ship, needs you, projects, queue, automations and brief. Read-only.
import { h, render } from './vendor/preact.js';
import { useEffect, useState } from './vendor/hooks.js';
import htm from './vendor/htm.js';
import { Masthead, openInOrca, say } from './ui.js';
import { Bird, Nest, StatusBird, PAGES } from './roost.js';

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

// Focused pages show every row unless `expanded` says otherwise.
function More({ items, row, expanded }) {
  const [all, setAll] = useState(() => expanded ?? Boolean(currentView()));
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
  const { ready, waitingPrs, reviewPrs } = data;
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
    </${Section}>
    <${Section} id="review" title="Ready to open for review" count=${reviewPrs.length} tone=${reviewPrs.length ? 'go' : ''}
      note="Drafts with every check passing and no conflicts">
      ${reviewPrs.length
        ? html`<${More} items=${reviewPrs} row=${(pr) => html`
            <li key=${pr.number}><span class="title"><a href=${pr.url}>#${pr.number} ${pr.title}</a></span></li>`} />`
        : html`<p class="now-muted empty">No green drafts right now.</p>`}
    </${Section}>`;
}

function Group({ label, items, row, empty, collapsed = false, expanded }) {
  const heading = html`${label} <span class="count">${items.length}</span>`;
  const content = items.length ? html`<${More} items=${items} row=${row} expanded=${expanded} />` : html`<p class="now-muted empty">${empty}</p>`;
  return collapsed
    ? html`<details class="group attention-backlog"><summary>${heading}</summary>${content}</details>`
    : html`<div class="group"><h3>${heading}</h3>${content}</div>`;
}

const ATTENTION = {
  waiting: ['Waiting on you', 'Questions, approvals and reviews awaiting your response.'],
  blocked: ['Blocked', 'Work with an explicitly reported obstacle. The reason appears on each row.'],
  failed: ['Failed', 'Reported failures from workspaces, run tasks and the latest automation runs.'],
  fyi: ['FYI', 'Completed work and informational updates. No response required.']
};

const AttentionRow = ({ item: a, state }) => html`
  <li>
    <span class=${`presence ${state}`} aria-hidden="true"></span>
    <span class="title">${a.ask}</span>
    <span class="detail">${a.name}${a.host ? ` · ${hostLabel(a.host)}` : ''}${a.pr ? html` · <a href=${a.pr.url}>PR #${a.pr.number}</a>` : ''}</span>
    ${a.workspaceKey !== null && html`<button class="text open" type="button" onClick=${() => openInOrca(a.workspaceKey || a.key, a.name)}>Open in Orca</button>`}
    ${a.workspaceKey === null && a.url && html`<a class="run-link" href=${a.url}>${a.linkText || 'View run'}</a>`}
  </li>`;

function Attention({ data }) {
  const [selected, setSelected] = useState('waiting');
  // Keep a tab opened during the server update readable until its next refresh.
  const attention = data.attention || { waiting: data.blocked, blocked: [], failed: [], fyi: [], stalled: [] };
  const { agents, reviews, ease, drafts } = attention.waiting;
  const counts = { waiting: agents.length + reviews.length + ease.length + drafts.length,
    blocked: attention.blocked.length, failed: attention.failed.length, fyi: attention.fyi.length };
  return html`
    <${Section} id="attention" title="Work status">
      <div class="status-filters" role="group" aria-label="Work status filters">
        ${Object.entries(ATTENTION).map(([state, [label]]) => html`
          <button key=${state} type="button" class=${`status-filter ${state}`} aria-pressed=${selected === state} onClick=${() => setSelected(state)}>
            <span class=${`presence ${state}`} aria-hidden="true"></span>${label}<span class="count">${counts[state]}</span>
          </button>`)}
      </div>
      <p class="now-muted status-description">${ATTENTION[selected][1]}</p>
      ${selected === 'waiting' ? html`
        <div class="groups">
          <${Group} label="Requests and decisions" items=${agents} empty="No workspace is waiting for your response."
            row=${a => html`<${AttentionRow} key=${a.key} item=${a} state="waiting" />`} />
          <${Group} label="Review backlog" items=${reviews} empty="No reviews requested." collapsed
            row=${r => html`<li key=${r.url}><span class="title"><a href=${r.url}>#${r.number} ${r.title}</a> <span class="detail">· ${r.author}</span></span></li>`} />
          ${ease.length > 0 && html`<${Group} label="Ease decisions" items=${ease} empty="No decisions pending."
            row=${e => html`<li key=${e.link || e.title}><span class="title"><${Link} href=${e.nextUrl}>${e.next}</${Link}></span><span class="detail"><${Link} href=${e.link}>${e.title}</${Link}></span></li>`} />`}
          ${drafts.length > 0 && html`<${Group} label="Draft inboxes" items=${drafts} collapsed
            row=${d => html`<li key=${d.name}><span class="title"><a href=${`/work#inbox=${encodeURIComponent(d.label)}`}>${d.name}</a></span><span class="detail">${d.unread} unread</span></li>`} />`}
        </div>` : attention[selected].length ? html`
          <${More} key=${selected} items=${attention[selected]} row=${a => html`<${AttentionRow} key=${a.key} item=${a} state=${selected} />`} />`
          : html`<p class="now-muted empty">${{ blocked: 'No explicit blockers reported.', failed: 'No failed runs or workspace failures reported.', fyi: 'No informational updates reported.' }[selected]}</p>`}
      ${attention.stalled.length > 0 && html`<${Group} label="Needs restart" items=${attention.stalled} collapsed
        row=${a => html`<${AttentionRow} key=${a.key} item=${a} state="stuck" />`} />`}
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
    <${Section} id="releases" title="Project watch" tone="info" note="Weeks, not hours. Live releases show what their watcher logs; local work shows its progress file, one point a day.">
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
                : `Nothing logged yet in ${r.channel}`}
            </span>
            ${r.progress && html`<span class="epic">${r.progress.completed} of ${r.progress.total} ${r.progress.label}
              <meter min="0" max=${r.progress.total || 1} value=${r.progress.completed}></meter></span>`}
            ${r.key && html`<button class="text open" type="button" onClick=${() => openInOrca(r.key, r.name)}>Open in Orca</button>`}
            ${r.epic && html`<span class="epic"><a href=${r.epic.url}>#${r.epic.number}</a> ${r.epic.completed} of ${r.epic.total} done
              <meter min="0" max=${r.epic.total || 1} value=${r.epic.completed}></meter></span>`}
          </li>`)}
      </ul>
    </${Section}>`;
}

const KIND = { hotfix: 'Hotfix', review: 'Review', mention: 'Ping reply', bugfix: 'Bug fix', ease: 'Ease', easywin: 'Easy win', todo: 'Staff To Do', backlog: 'Backlog build', prep: 'Backlog prep' };
const VERB = { queued: 'Queued', started: 'Started', skipped: 'Skipped', error: 'Error', retry: 'Retry', expired: 'Expired', other: 'Log' };
const waited = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.round(ms / 3600000)}h`);
const What = ({ what }) => html`<${Link} href=${what.url}>${what.label}</${Link}>${what.at ? ` from ${when(what.at)}` : ''}${what.title ? html` <span class="what-title">${what.title}</span>` : ''}`;
// The workspace's current Orca note, opening the workspace when it's still there.
const Note = ({ ws, outcome }) => (ws?.comment
  ? (ws.key
    ? html`<button class="ws-note" type="button" title=${`Open ${ws.name} in Orca`} onClick=${() => openInOrca(ws.key, ws.name)}>${ws.comment}</button>`
    : html`<span class="ws-note">${ws.comment}</span>`)
  : outcome ? html`<span class="ws-note">${outcome}</span>` : null);
const Workspace = ({ ws }) => (ws.key
  ? html`<button class="ws" type="button" title="Open in Orca" onClick=${() => openInOrca(ws.key, ws.name)}>${ws.name}</button>`
  : html`<span class="ws">${ws.name}</span>`);

function Slots({ data }) {
  const s = data.slots;
  const note = 'Every VM automation that starts a workspace agent queues here; slots.timer starts the best fit every 5 minutes.';
  if (!s) {
    return html`
      <${Section} id="slots" title="Agent slots" tone="info" note=${note}>
        <p class="warning">Couldn't reach the VM's slot queue${data.slotsError ? `: ${data.slotsError}` : '.'}</p>
      </${Section}>`;
  }
  return html`
    <${Section} id="slots" title="Agent slots" tone="info" count=${s.queue.length || null} note=${note}>
      <div class="budget">
        <span><strong>${s.used} of ${s.budget}</strong> budget in use</span>
        <meter min="0" max=${s.budget} value=${s.used} aria-label="Slot budget in use"></meter>
        ${s.paused
          ? html`<span class="chip paused">Waiting: ${s.paused}</span>`
          : html`<span class="now-muted">VM checked ${when(s.at)}</span>`}
      </div>
      <ul class="kinds" aria-label="Slots per kind">
        ${s.kinds.map((k) => html`
          <li key=${k.kind} class=${k.running.length ? 'busy' : ''}>
            <span class="kind">${KIND[k.kind] || k.kind}</span>
            <span class="used">${k.running.length}/${k.most}</span>
            ${k.running.map((ws) => html`<${Workspace} key=${ws.name} ws=${ws} />`)}
          </li>`)}
      </ul>
      <div class="groups">
        <div class="group">
          <h3>Up next <span class="count">${s.queue.length}</span></h3>
          ${s.queue.length
            ? html`<${More} items=${s.queue} row=${(q) => html`
                <li key=${q.key}>
                  <span class="pos">${q.position}</span>
                  <span class="chip">${KIND[q.kind] || q.kind}</span>
                  <span class="title grow"><${What} what=${q.what} /><${Note} ws=${q.workspace} outcome=${q.outcome} /></span>
                  <span class="detail">waited ${waited(q.waitedMs)} · priority ${q.priority}</span>
                  <span class=${`fit ${q.fitsNow ? 'yes' : ''}`}>${q.fitsNow ? 'Fits now' : 'Waiting for room'}</span>
                </li>`} />`
            : html`<p class="now-muted empty"><${Bird} state="idle" />Nothing queued.</p>`}
        </div>
        <div class="group">
          <h3>Recent</h3>
          ${s.recent.length
            ? html`<${More} items=${s.recent} row=${(r, i) => html`
                <li key=${`${r.at}${i}`} class=${`verb-${r.verb}`}>
                  <span class=${`chip verb ${r.verb}`}>${VERB[r.verb] || r.verb}</span>
                  ${r.kind && html`<span class="detail">${KIND[r.kind] || r.kind}</span>`}
                  <span class="title grow"><${What} what=${r.what} /><${Note} ws=${r.workspace} outcome=${r.outcome} /></span>
                  ${r.note && r.note !== r.verb && html`<span class="detail">${r.note}</span>`}
                  <span class="when">${when(r.at)}</span>
                </li>`} />`
            : html`<p class="now-muted empty">No starts yet.</p>`}
        </div>
      </div>
    </${Section}>`;
}

const OUTCOME = [['success', 'succeeded'], ['skipped', 'skipped'], ['failed', 'failed'], ['running', 'in progress']];

// Hides the row at once; the server keeps it hidden on later reads.
async function markIntakeReviewed(r, hide) {
  try {
    const res = await fetch('/api/intake/reviewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
      body: JSON.stringify({ key: r.key })
    });
    if (!res.ok) throw new Error((await res.json()).error);
    hide(r.key);
  } catch (e) {
    say(e.message || `Couldn't mark #${r.issue} reviewed.`);
  }
}

function Intake({ data }) {
  const [hidden, setHidden] = useState(() => new Set());
  const hide = (key) => setHidden((h) => new Set(h).add(key));
  const s = data.intake && { ...data.intake, reviews: data.intake.reviews.filter((r) => !hidden.has(r.key)) };
  const note = 'ai-new-ticket.yml in gobranch/branch, last 24 hours. Skipped runs are normal: most issue comments need no run.';
  if (!s) {
    return html`
      <${Section} id="intake" title="New-ticket intake" tone="info" note=${note}>
        <p class="warning">Couldn't read the intake workflow${data.intakeError ? `: ${data.intakeError}` : '.'}</p>
      </${Section}>`;
  }
  const others = Object.keys(s.counts).filter((k) => !OUTCOME.some(([o]) => o === k));
  return html`
    <${Section} id="intake" title="New-ticket intake" tone=${s.live ? 'info' : 'you'} count=${s.reviews.length || null} note=${note}>
      <div class="budget">
        ${s.live
          ? html`<span class="chip intake-live">Live</span><span class="now-muted">Writes to tickets (AI_INTAKE_LIVE is true)</span>`
          : html`<span class="chip intake-dry">Dry run</span><strong>Writes nothing to tickets.</strong>
              <span class="now-muted">AI_INTAKE_LIVE is ${s.liveValue ? `"${s.liveValue}"` : 'not set'}; set it to true to go live.</span>`}
      </div>
      <p class="intake-counts">
        <a href=${s.url}>${s.total} ${s.total === 1 ? 'run' : 'runs'}</a>:
        ${[...OUTCOME, ...others.map((k) => [k, k.replace(/_/g, ' ')])].map(([k, label], i) => html`${i ? ' · ' : ' '}<span class=${`n ${k} ${s.counts[k] ? '' : 'zero'}`}>${s.counts[k] || 0} ${label}</span>`)}
        <span class="now-muted"> · checked ${clock(s.at)}</span>
      </p>
      <div class="groups">
        <${Group} label="Needs review" items=${s.reviews} empty="No ticket needs review."
          row=${(r) => html`<li key=${`${r.url}${r.issue}`}><span class="title"><a href=${r.url}>#${r.issue}: ${r.items} ${r.items === 1 ? 'item needs' : 'items need'} review</a></span><span class="when">${when(r.at)}</span>
            <button class="text open" type="button" onClick=${() => markIntakeReviewed(r, hide)}>Reviewed</button></li>`} />
        <${Group} label="Failed runs" items=${s.failed} empty="No failed runs."
          row=${(r) => html`<li key=${r.url}><span class="title"><a href=${r.url}>${r.title}</a></span><span class="when">${when(r.at)}</span></li>`} />
      </div>
      ${s.unchecked > 0 && html`<p class="now-muted">${s.unchecked} older finished ${s.unchecked === 1 ? 'run wasn’t' : 'runs weren’t'} checked for review items.</p>`}
    </${Section}>`;
}

const PLAN_STATUS = { building: 'Building', approved: 'Approved', draft: 'Draft', 'on-hold': 'On hold' };

function Plans({ data }) {
  const s = data.plans;
  const note = 'Plans, specs and designs in process-updates/docs that aren’t done or superseded, from each doc’s front matter.';
  if (!s) {
    return html`
      <${Section} id="plans" title="Upcoming plans" tone="info" note=${note}>
        <p class="warning">Couldn't read the plan docs${data.plansError ? `: ${data.plansError}` : '.'}</p>
      </${Section}>`;
  }
  const finished = (s.counts.done || 0) + (s.counts.superseded || 0);
  return html`
    <${Section} id="plans" title="Upcoming plans" tone="info" count=${s.upcoming.length} note=${note}>
      ${s.upcoming.length ? html`<${More} items=${s.upcoming} row=${(p) => html`
        <li key=${p.file} class="plan">
          <span class=${`chip plan-${p.status}`}>${PLAN_STATUS[p.status]}</span>
          <span class="title"><a href=${`/plan?file=${encodeURIComponent(p.file)}`}>${p.title || p.file}</a></span>
          ${p.kind !== 'doc' && html`<span class="detail">${p.kind}</span>`}
          <span class="when">${p.stale ? html`<span class="stale">No change in ${ago(p.updatedAt).replace(' ago', '')}</span>` : `Updated ${ago(p.updatedAt)}`}</span>
          <span class="detail plan-next">${p.next ? `Next: ${p.next}` : 'No next step written'}</span>
          <span class="detail plan-file">${p.file}</span>
        </li>`} />` : html`<p class="now-muted empty">No upcoming plans.</p>`}
      ${s.unlabeled.length > 0 && html`<p class="warning">Missing status or next step: ${s.unlabeled.join(', ')}</p>`}
      <p class="now-muted">${finished} done or superseded, not shown.</p>
    </${Section}>`;
}

const STATUS = { failed: 'Failed', overdue: 'Missed run', unreadable: 'Unreadable', running: 'Running', completed: 'Run finished', paused: 'Paused', waiting: 'Not run yet', skipped: 'Skipped', cancelled: 'Stopped' };

function Automations({ data }) {
  const [showPaused, setShowPaused] = useState(false);
  const rows = data.automations.filter((a) => showPaused || a.status !== 'paused');
  const paused = data.automations.length - data.automations.filter((a) => a.status !== 'paused').length;
  return html`
    <${Section} id="automations" title="Automations" tone="lilac" count=${rows.length}
      note=${html`For Orca automations, Run finished means Orca marked it complete, not that the work succeeded. For LaunchAgents and systemd timers, it means the last run exited cleanly.`}>
      <div class="table-scroll" role="region" aria-label="Automation runs" tabindex="0"><table class="autos">
        <thead><tr><th scope="col">Status</th><th scope="col">Automation</th><th scope="col">Where</th><th scope="col">Last run</th><th scope="col">Next run</th></tr></thead>
        <tbody>
          ${rows.map((a) => html`
            <tr key=${a.key} class=${a.status}>
              <td><span class=${`dot ${a.status}`} aria-hidden="true"></span><${StatusBird} status=${a.status} />${STATUS[a.status] || a.status}</td>
              <td>${a.name}${a.logs && html` <span class="row-links"><a href=${`/work#logs=${encodeURIComponent(a.logs)}`}>Logs</a>${a.findings && html` · <a href=${`/work#findings=${encodeURIComponent(a.logs)}`}>Findings</a>`}</span>`}${a.kind && html`<div class="detail">${a.kind}</div>`}${a.error && html`<div class="detail">${a.error}</div>`}${(a.actions || []).slice(0, 3).map((x) => html`<div class="detail action" title=${x.text}>${x.at ? `${ago(x.at)}: ` : ''}${x.text}</div>`)}</td>
              <td>${hostLabel(a.host)}</td>
              <td>${a.lastRunAt ? ago(a.lastRunAt) : '—'}</td>
              <td>${a.nextRunAt ? when(a.nextRunAt) : a.schedule || '—'}</td>
            </tr>`)}
        </tbody>
      </table></div>
      ${paused > 0 && html`<button class="text more" type="button" onClick=${() => setShowPaused(!showPaused)}>${showPaused ? 'Hide paused' : `Show ${paused} paused`}</button>`}
    </${Section}>`;
}

function Brief({ expanded = false }) {
  const { data, error } = usePoll('/api/brief', 300000);
  if (!data) return html`<section class="tier"><h2>Daily brief</h2><p class="now-muted" role="status">${error || 'Loading daily brief…'}</p></section>`;
  return html`
    <details class="tier brief" open=${expanded}>
      <summary><h2>Daily brief</h2><span class="now-muted">${data.error || (data.writtenAt ? `Written ${when(data.writtenAt)} on the VM` : 'No brief yet')}</span></summary>
      ${data.html && html`<div class="brief-body" dangerouslySetInnerHTML=${{ __html: data.html }} />`}
    </details>`;
}

// --- Backlog ---------------------------------------------------------------------------------------------

const STAGE = {
  done: 'Done', dropped: 'Closed', 'other-team': 'Other team', building: 'Building', ready: 'Prioritized',
  refine: 'Needs refinement', triage: 'Needs triage', unowned: 'No dev team', 'out-of-scope': 'Out of scope'
};
const SORTED_STAGES = ['done', 'dropped', 'other-team', 'building', 'ready'];
const isClosed = (t) => ['done', 'dropped'].includes(t.stage);
const num = (n) => (n == null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(1));

function Trend({ trend }) {
  const w = 160;
  if (trend.length < 2) return null;
  const max = Math.max(1, ...trend.map((t) => t.remaining));
  const step = w / (trend.length - 1);
  const points = trend.map((t, i) => `${(i * step).toFixed(1)},${(22 - (t.remaining / max) * 20).toFixed(1)}`).join(' ');
  return html`<svg class="spark" viewBox="0 0 ${w} 24" width=${w} height="24" role="img" aria-label=${`Still to sort: ${trend.map((t) => `${day(t.date)} ${t.remaining}`).join(', ')}`}><polyline points=${points} /></svg>`;
}

function Changes({ items }) {
  if (!items?.length) return null;
  return html`<ul class="changes" aria-label="What changed">
    ${items.map((c, i) => {
      const body = html`<b>${c.label}</b>${c.from ? html` ${c.from} <span aria-hidden="true">→</span><span class="sr-only">to</span>` : ''}${c.to ? ` ${c.to}` : ''}`;
      return html`<li key=${i}>${c.url ? html`<a href=${c.url}>${body}</a>` : body}</li>`;
    })}
  </ul>`;
}

async function postJson(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// What each kind of ask offers. GitHub writes (team, status, close, comment) ask for a second click first.
const CHOICES = {
  'Close recommended': [['close', 'not planned', 'Close: not planned'], ['close', 'completed', 'Close: done'], ['keep', '', 'Keep open']],
  'Dev team unclear': [['team', 'Staff', 'Staff'], ['team', 'Non-Staff', 'Non-Staff'], ['team', 'Integrations', 'Integrations'], ['close', 'not planned', 'Close: not planned']],
  'Product decisions': [['status', 'To Do (Dev)', 'Ready: To Do'], ['status', 'Needs Refinement', 'Needs refinement'], ['close', 'not planned', 'Close: not planned']],
  'Refinement blocked': [['status', 'To Do (Dev)', 'Ready: To Do'], ['close', 'not planned', 'Close: not planned']]
};
const GITHUB_ACTIONS = ['team', 'status', 'close', 'comment'];
const describeAnswer = (a) => ({
  team: `Dev Team → ${a.value}`, status: `Status → ${a.value}`, close: `Closed: ${a.value}`, keep: 'Keep open',
  skip: 'Skipped for a week', note: 'Note for the agents', comment: 'Commented', question: `Answered ${a.value}`
}[a.action] || a.action);

function Answer({ t, section, onDone }) {
  const [text, setText] = useState('');
  const [writing, setWriting] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (action, value = '') => {
    setBusy(true);
    setError('');
    try {
      const body = { number: t.number, action, value };
      if (action === 'comment' || action === 'close') body.comment = text;
      if (action !== 'comment' && action !== 'close' && text) body.note = text;
      const r = await postJson('/api/backlog/answer', body);
      onDone({ action, value, note: body.note, at: r.at, url: r.url, warning: r.warning });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const pick = (action, value, label) => (GITHUB_ACTIONS.includes(action) ? setConfirm({ action, value, label }) : send(action, value));
  const choices = [...(CHOICES[section] || []), ['skip', '', 'Skip a week']];
  return html`
    <div class="answer">
      <div class="answer-buttons" role="group" aria-label=${`Answer #${t.number}`}>
        ${choices.map(([action, value, label]) => html`<button key=${label} type="button" class="secondary" disabled=${busy} onClick=${() => pick(action, value, label)}>${label}</button>`)}
        ${!writing && html`<button type="button" class="text" onClick=${() => setWriting(true)}>Write a comment or note</button>`}
      </div>
      ${writing && html`<label class="answer-text"><span class="sr-only">Your words on #${t.number}</span>
        <textarea rows="3" autofocus placeholder="A comment for the ticket (posts as you), or a private note for the agents" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      </label>`}
      ${text.trim() && html`<div class="answer-buttons">
        <button type="button" class="secondary" disabled=${busy} onClick=${() => pick('comment', '', 'Post as comment')}>Post as comment</button>
        <button type="button" class="secondary" disabled=${busy} onClick=${() => send('note')}>Save as private note</button>
      </div>`}
      ${confirm && html`<p class="answer-confirm" role="alert">
        ${confirm.action === 'comment' ? `Post this on #${t.number} as you?` : `${confirm.label} on #${t.number}${confirm.action === 'close' && text.trim() ? ', with your text as the closing comment' : ''}? This writes to GitHub as you.`}
        <button type="button" disabled=${busy} onClick=${() => send(confirm.action, confirm.value)}>${busy ? 'Sending…' : 'Confirm'}</button>
        <button type="button" class="text" disabled=${busy} onClick=${() => setConfirm(null)}>Cancel</button>
      </p>`}
      ${error && html`<p class="warning" role="alert">${error}</p>`}
    </div>`;
}

function BacklogTicket({ t, why, section, answered, onAnswer }) {
  const facts = [t.size != null && `size ${num(t.size)}`, t.priority ? `priority ${num(t.priority)}` : ''].filter(Boolean).join(' · ');
  const reason = why || t.verdict;
  const done = answered || t.answer;
  return html`
    <li key=${t.number} class="backlog-row">
      <span class=${`chip stage ${t.stage}`}>${STAGE[t.stage] || t.stage}</span>
      <div class="title grow">
        <span><a href=${t.url}>#${t.number}</a> <span class="what-title">${t.title}</span></span>
        <${Changes} items=${t.changes} />
        ${t.prep && html`<span class="ws-note"><b>Prep:</b> ${t.prep.recommendation}</span>`}
        ${reason && (section
          ? html`<p class="ask">${reason}</p>`
          : html`<details class="why"><summary>Why</summary><p>${reason}</p></details>`)}
        ${done
          ? html`<p class="answered">You: ${describeAnswer(done)}${done.note ? ` · “${done.note}”` : ''} · ${when(Date.parse(done.at))}${done.url ? html` · <a href=${done.url}>on GitHub</a>` : ''}${done.warning ? html` <span class="warning">${done.warning}</span>` : ''}</p>`
          : section && html`<${Answer} t=${t} section=${section} onDone=${(a) => onAnswer(t.number, a)} />`}
      </div>
      ${facts && html`<span class="detail">${facts}</span>`}
    </li>`;
}

function Question({ q }) {
  const [answer, setAnswer] = useState(q.answer);
  const [error, setError] = useState('');
  const send = async (value) => {
    try {
      const r = await postJson('/api/backlog/answer', { action: 'question', question: q.text, value });
      setAnswer({ value, at: r.at });
    } catch (e) {
      setError(e.message);
    }
  };
  return html`
    <div class="backlog-question">
      <p>${q.text}</p>
      ${answer
        ? html`<p class="answered">You answered ${answer.value} · ${when(Date.parse(answer.at))}. The next pass reads it.</p>`
        : html`<div class="answer-buttons"><button type="button" class="secondary" onClick=${() => send('yes')}>Yes</button><button type="button" class="secondary" onClick=${() => send('no')}>No</button></div>`}
      ${error && html`<p class="warning" role="alert">${error}</p>`}
    </div>`;
}

function Backlog() {
  const { data, error } = usePoll('/api/backlog', 300000);
  const [mine, setMine] = useState({});
  if (!data) return html`<section class="tier"><h2>Backlog</h2><p class="now-muted" role="status">${error || 'Loading the backlog…'}</p></section>`;
  if (data.error) {
    return html`<${Section} id="backlog" title="Backlog" tone="info"><p class="warning">Couldn't read the backlog status: ${data.error}</p></${Section}>`;
  }
  const onAnswer = (n, a) => setMine((m) => ({ ...m, [n]: a }));
  const first = data.trend[0];
  const prev = data.trend.filter((t) => !t.baseline && t.date < data.date).at(-1);
  const open = data.needsYou.map((a) => ({ ...a, tickets: a.tickets.filter((t) => !mine[t.number]) }));
  const asks = open.reduce((n, a) => n + a.tickets.length, 0);
  const answeredHere = data.needsYou.flatMap((a) => a.tickets.filter((t) => mine[t.number]).map((t) => ({ ...t, answer: mine[t.number], section: a.section })));
  const answered = [...answeredHere, ...(data.answered || [])];
  const row = (t) => html`<${BacklogTicket} key=${t.number} t=${t} />`;
  const easy = data.tiers.find((t) => t.id === 'easy');
  const easyDone = easy ? easy.tickets.filter(isClosed).length : 0;
  return html`
    <${Section} id="backlog-progress" title="Sorting the Staff backlog" tone="info"
      note=${`The ${data.total} tickets in the Staff backlog pass, checked hourly on the VM (last ${when(Date.parse(data.at))}).`}>
      ${data.stale && html`<p class="warning">The last check is over 3 hours old: look at backlog-status in Automations.</p>`}
      <div class="budget">
        <span><strong>${data.remaining} of ${data.total}</strong> still to sort</span>
        <meter min="0" max=${data.total || 1} value=${data.total - data.remaining} aria-label="Tickets sorted"></meter>
        <${Trend} trend=${data.trend} />
        ${prev && html`<span class="now-muted">${prev.remaining === data.remaining ? `Same as ${day(prev.date)}` : prev.remaining > data.remaining ? `${prev.remaining - data.remaining} sorted since ${day(prev.date)}` : `${data.remaining - prev.remaining} more to sort than ${day(prev.date)}`}</span>`}
        ${first && first.date !== data.date && html`<span class="now-muted">${first.remaining} on ${day(first.date)}, when the pass started</span>`}
      </div>
      <ul class="pills stages" aria-label="Tickets by stage">
        ${Object.keys(STAGE).filter((k) => data.counts[k]).map((k) => html`
          <li key=${k} class=${SORTED_STAGES.includes(k) ? '' : 'bad'}>${STAGE[k]} ${data.counts[k]}</li>`)}
      </ul>
      <p class="now-muted">Sorted means prioritized, being built, closed or with another team.${data.prepped > 0 ? ` ${data.prepped} prepped overnight for you: see the Prep notes under Needs you.` : ''}</p>
    </${Section}>
    <${Section} id="backlog-changed" title="What changed" tone="info" count=${data.recent?.length || null}
      note=${data.since ? `Since ${day(data.since)}, from the hourly checks.` : 'Day-over-day changes start with tomorrow’s first check. Each ticket’s tags show everything since the pass.'}>
      ${data.recent?.length
        ? html`<${More} items=${data.recent} expanded=${false} row=${(t) => html`
            <li key=${t.number} class="backlog-row">
              <span class=${`chip stage ${t.stage}`}>${STAGE[t.stage] || t.stage}</span>
              <div class="title grow"><span><a href=${t.url}>#${t.number}</a> <span class="what-title">${t.title}</span></span><${Changes} items=${t.changes} /></div>
            </li>`} />`
        : data.since && html`<p class="now-muted empty">Nothing moved since ${day(data.since)}.</p>`}
    </${Section}>
    <${Section} id="backlog-next" title="Build next" tone="go"
      note="Easy wins first, then prioritized Staff tickets by size, highest priority first.">
      <div class="groups">
        ${data.tiers.filter((t) => t.tickets.length).map((t) => html`
          <${Group} key=${t.id} label=${t.id === 'easy' ? `${t.label}: ${easyDone} of ${t.tickets.length} done` : t.label}
            items=${t.id === 'easy' ? [...t.tickets].sort((x, y) => isClosed(x) - isClosed(y)) : t.tickets}
            empty="" row=${row} collapsed=${t.id === 'unsized'} expanded=${false} />`)}
      </div>
    </${Section}>
    <${Section} id="backlog-you" title="Needs you" tone="you" count=${asks}
      note="The pass's asks still open. Answer here: GitHub changes ask you to confirm, and notes reach only the agents.">
      ${(data.questions || []).map((q) => html`<${Question} key=${q.text} q=${q} />`)}
      <div class="groups">
        ${open.filter((a) => a.tickets.length).map((a) => html`
          <${Group} key=${a.section} label=${a.action} items=${a.tickets} empty="" expanded=${false}
            row=${(t) => html`<${BacklogTicket} key=${t.number} t=${t} why=${t.why} section=${a.section} onAnswer=${onAnswer} />`} />`)}
      </div>
    </${Section}>
    ${answered.length > 0 && html`
      <${Section} id="backlog-answered" title="Your answers" tone="info" count=${answered.length}
        note="Answers stay here; the ticket's tags show when GitHub has caught up.">
        <${More} items=${answered} expanded=${false} row=${(t) => html`<${BacklogTicket} key=${t.number} t=${t} why=${t.why} answered=${t.answer} />`} />
      </${Section}>`}
    ${data.remainingTickets.length > 0 && html`
      <${Section} id="backlog-rest" title="Still to sort" tone="info" count=${data.remainingTickets.length}
        note="Unsorted tickets with no question for you. The next pass picks them up.">
        <${More} items=${data.remainingTickets} row=${row} expanded=${false} />
      </${Section}>`}`;
}

// --- Evals -----------------------------------------------------------------------------------------------
const EVALS_PLAN = '/plan?file=2026-11-10-in-house-evals-plan.md';
// Run ids are UTC stamps such as 20261112T150405Z.
const runTime = (r) => Date.parse(`${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}T${r.slice(9, 11)}:${r.slice(11, 13)}:${r.slice(13, 15)}Z`) || null;
const CHANGE = { regressed: ['▼', 'worse than the previous run'], improved: ['▲', 'better than the previous run'] };

function TrialDetail({ s, task, config }) {
  const cell = s.cells[task]?.[config];
  if (!cell) return null;
  return html`
    <div class="eval-detail" aria-live="polite">
      <h3>${task} · ${config}: ${cell.passed} of ${cell.total} passed${cell.previous ? ` (previous run ${cell.previous.passed} of ${cell.previous.total})` : ''}</h3>
      ${cell.trials.map((t) => {
        const keys = [...new Set([...Object.keys(t.want || {}), ...Object.keys(t.got || {})])];
        return html`
          <div class="eval-trial" key=${t.rep}>
            <p><span class=${`chip ${t.pass ? 'plan-building' : 'error'}`}>${t.pass ? 'Pass' : 'Fail'}</span>
              Try ${t.rep + 1} · ${t.secs}s${t.cost != null ? ` · $${t.cost.toFixed(3)}` : ''}${t.model ? ` · ${t.model}` : ''}${t.skill_version ? ` · skill ${t.skill_version}` : ''}</p>
            ${t.err && html`<p class="warning">Error: ${t.err}</p>`}
            ${keys.length > 0 && html`
              <div class="table-scroll"><table class="eval-fields">
                <thead><tr><th scope="col">Field</th><th scope="col">Expected</th><th scope="col">Got</th></tr></thead>
                <tbody>${keys.map((k) => {
                  const want = t.want?.[k] ?? null;
                  const got = t.got?.[k] ?? null;
                  return html`<tr key=${k} class=${want === got ? '' : 'mismatch'}><th scope="row">${k}</th><td>${String(want)}</td><td>${String(got)}</td></tr>`;
                })}</tbody>
              </table></div>`}
          </div>`;
      })}
    </div>`;
}

function Suite({ s }) {
  const [sel, setSel] = useState(null);
  const regressions = s.tasks.flatMap((task) => s.configs.map((c) => s.cells[task][c]?.change)).filter((c) => c === 'regressed').length;
  return html`
    <${Section} id=${`eval-${s.suite}`} title=${s.title || s.suite} tone=${regressions ? 'alarm' : 'info'}
      note=${`Latest run ${when(runTime(s.run) || s.at)} · ${s.runs} ${s.runs === 1 ? 'run' : 'runs'} saved${regressions ? ` · ${regressions} ${regressions === 1 ? 'cell' : 'cells'} worse than the previous run` : ''}. Click a cell for each try's answers.`}>
      <ul class="rows eval-totals">
        ${s.totals.map((t) => html`
          <li key=${t.config}>
            <span class="title">${t.config}</span>
            <span><strong>${t.passed} of ${t.total}</strong> passed${t.errors ? html`, <span class="stale">${t.errors} ${t.errors === 1 ? 'error' : 'errors'}</span>` : ''}</span>
            <span class="detail">$${t.cost.toFixed(2)} · ${Math.round(t.secs / 60)} min of runs${t.skillVersions.length ? ` · skill ${t.skillVersions.join(', ')}` : ''}</span>
            ${t.trend.length > 1 && html`<span class="detail">Earlier: ${t.trend.slice(0, -1).slice(-3).map((r) => `${r.passed} of ${r.total} (${when(runTime(r.run))})`).join(', ')}</span>`}
          </li>`)}
      </ul>
      <div class="table-scroll" role="region" aria-label=${`${s.title || s.suite} results by task`} tabindex="0">
        <table class="eval-grid">
          <thead><tr><th scope="col">Task</th>${s.configs.map((c) => html`<th scope="col" key=${c}>${c}</th>`)}</tr></thead>
          <tbody>${s.tasks.map((task) => html`
            <tr key=${task}><th scope="row">${task}</th>${s.configs.map((c) => {
              const cell = s.cells[task][c];
              if (!cell) return html`<td key=${c}>—</td>`;
              const state = cell.passed === cell.total ? 'pass' : cell.passed ? 'partial' : 'fail';
              const pressed = sel?.task === task && sel?.config === c;
              const [mark, why] = CHANGE[cell.change] || [];
              return html`<td key=${c}><button type="button" class=${`eval-cell ${state}`} aria-pressed=${pressed}
                aria-label=${`${c} on ${task}: ${cell.passed} of ${cell.total} passed${why ? `, ${why}` : ''}`}
                onClick=${() => setSel(pressed ? null : { task, config: c })}>${cell.passed}/${cell.total}${mark && html` <span class=${`change ${cell.change}`} aria-hidden="true">${mark}</span>`}</button></td>`;
            })}</tr>`)}
          </tbody>
        </table>
      </div>
      ${sel && html`<${TrialDetail} s=${s} task=${sel.task} config=${sel.config} />`}
      ${s.unreadable > 0 && html`<p class="warning">${s.unreadable} unreadable ${s.unreadable === 1 ? 'line' : 'lines'} in results/${s.suite}.jsonl.</p>`}
    </${Section}>`;
}

function Evals() {
  const { data, error } = usePoll('/api/evals', 300000);
  if (!data) return html`<section class="tier"><h2>Benchmarks</h2><p class="now-muted" role="status">${error || 'Loading benchmark results…'}</p></section>`;
  return html`
    ${data.suites.length
      ? data.suites.map((s) => html`<${Suite} key=${s.suite} s=${s} />`)
      : html`<${Section} id="eval-none" title="Benchmarks" tone="info"><p class="now-muted empty">No benchmark results yet. Runners write them to evals/results/.</p></${Section}>`}
    <${Section} id="eval-scores" title="Scores" tone="info">
      <p class="now-muted">Not built yet: the judge scoring each job's real runs is build step 1 of the <a href=${EVALS_PLAN}>evals plan</a>.</p>
    </${Section}>
    <${Section} id="eval-loops" title="Learning loops" tone="info">
      <p class="now-muted">Not built yet: misses, judge corrections and proposals arrive with the first loop, build step 5 of the <a href=${EVALS_PLAN}>evals plan</a>.</p>
    </${Section}>`;
}

const VIEWS = { 'health': Down, 'ready': Ready, 'needs-you': Attention, 'projects': Releases, 'queue': Slots, 'plans': Plans, 'automations': Automations };
const currentView = () => {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(VIEWS, hash) || hash === 'brief' || hash === 'backlog' || hash === 'evals' ? hash : '';
};

function App() {
  const { data, error } = usePoll('/api/now', 60000);
  const [view, setView] = useState(currentView);
  useEffect(() => {
    const navigate = () => {
      setView(currentView());
      window.scrollTo(0, 0);
      requestAnimationFrame(() => document.querySelector('.page-heading h1')?.focus({ preventScroll: true }));
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const page = view ? `/#${view}` : '/';
  useEffect(() => { document.title = `Roost · ${PAGES.find(item => item.href === page).label}`; }, [page]);
  const Focused = VIEWS[view];
  return html`
    <${Masthead} page=${page} status=${error ? `Couldn't refresh: ${error}` : data ? `Updated ${clock(data.refreshedAt)}` : 'Checking everything…'} />
    ${view === 'brief' ? html`<${Brief} key="brief" expanded />` : view === 'backlog' ? html`<${Backlog} key="backlog" />` : view === 'evals' ? html`<${Evals} key="evals" />` : data ? Focused ? html`<${Focused} key=${view} data=${data} />` : html`
      <${Down} data=${data} />
      <${Ready} data=${data} />
      <${Attention} data=${data} />
      <${Releases} data=${data} />
      <${Plans} data=${data} />
      <${Slots} data=${data} />
      <${Intake} data=${data} />
      <${Automations} data=${data} />
      <${Brief} />
      ` : html`<p class="now-muted" role="status">${error || 'Loading your dashboard…'}</p>`}
    ${data?.errors.length > 0 && html`<footer class="errors"><strong>Couldn't read:</strong> ${data.errors.map((e) => `${e.source} (${e.error})`).join(' · ')}</footer>`}`;
}

const root = document.getElementById('app');
root.replaceChildren();
render(html`<${App} />`, root);
