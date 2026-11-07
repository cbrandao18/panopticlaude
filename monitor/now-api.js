// The Now page: what is down, what is ready to ship, what is blocked on Christie, how live releases are
// going, and every automation's latest status. Read-only. Each source fails on its own and shows as an error.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { orcaRunner } = require('./map-api');
const { runOnHost } = require('./security-api');

const exec = promisify(execFile);
const HOSTS = [
  { id: 'mac', label: 'Mac', args: [] },
  { id: 'vm', label: 'VM', args: ['--environment', 'cloud'] }
];
const OVERDUE_MS = 30 * 60000;

// Vendor status pages. Most are Atlassian Statuspage summaries; `components` narrows a shared page
// (Twilio's covers SMS and voice worldwide) to the parts Branch uses.
const sp = (name, host, extra = {}) => ({ name, kind: 'statuspage', url: `https://${host}/api/v2/summary.json`, page: `https://${host}`, ...extra });
const STATUS_PAGES = [
  sp('Claude', 'status.claude.com'),
  sp('GitHub', 'www.githubstatus.com'),
  { name: 'Stripe', kind: 'stripe', url: 'https://status.stripe.com/current', page: 'https://status.stripe.com' },
  { name: 'Basis Theory', kind: 'betteruptime', url: 'https://status.basistheory.com/index.json', page: 'https://status.basistheory.com' },
  sp('SendGrid', 'status.sendgrid.com', { components: /^SendGrid (Mail Sending|API|Webhooks)$/ }),
  sp('Smarty', 'status.smarty.com'),
  sp('Lob', 'lob.statuspage.io'),
  sp('Front', 'frontstatus.com'),
  sp('Dialpad', 'status.dialpad.com'),
  sp('SignNow', 'status.signnow.com'),
  sp('DocRaptor', 'status.docraptor.com'),
  sp('Routable', 'status.routable.com'),
  sp('Upstash', 'status.upstash.com'),
  sp('Iterable', 'status.iterable.com')
];

// Datadog monitors on Branch's own calls to vendors with no usable status page. Alert or Warn counts as down.
const VENDOR_MONITORS = {
  ClarionDoor: [335332041],
  Rater: [267030276, 58566275],
  Stripe: [275361197, 142135795, 152259079],
  TransUnion: [284942402],
  Mueller: [119208339],
  ChargeDesk: [113740075, 119983296],
  Routable: [82662756],
  Lob: [297360348],
  Descope: [320960814],
  Meilisearch: [146012432, 285788312]
};
// Business-critical but nothing watches them yet. Shown so the gap stays visible.
const UNWATCHED = ['Staff uptime', 'Verisk (MVR, A-PLUS)', 'Carfax', 'CoreLogic', 'CMT'];

// Live projects watched over weeks. Each reads the nightly triage log its feedback watcher writes.
const RELEASES = [
  {
    name: 'Staff new look',
    channel: '#staff-usability-feedback',
    log: '~/branch-workshop/staff-feedback-bot/logs/triage.log',
    epic: 37723
  },
  {
    name: 'Staff Tools Tool help',
    channel: 'Indemn Staff Tools Assist chats',
    log: '~/branch-workshop/tool-help-watch/triage.log',
    // Shown instead of fixes / design calls / vague; the spark plots `spark`.
    metrics: [['chats', 'chats'], ['bad', 'not working well']],
    spark: 'bad'
  },
  {
    name: 'Review skills',
    channel: 'the weekly skill-tuning runs',
    log: '~/branch-agents/projects/process-updates/skill-checks/runs.log',
    url: 'https://app.datadoghq.com/dashboard/fex-qhi-n9i/agent-skills-health',
    metrics: [['missed', 'missed issues'], ['stale', 'stale names'], ['cited', 'Devlo citations']],
    spark: 'missed'
  }
];

const clip = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text || '');

// --- Automations -------------------------------------------------------------------------------------------

function automationRow(host, automation, runs, now = Date.now()) {
  const latest = [...runs].sort((a, b) => (b.createdAt || b.scheduledFor) - (a.createdAt || a.scheduledFor))[0] || null;
  let status = 'waiting';
  if (!automation.enabled) status = 'paused';
  else if (['dispatching', 'dispatched', 'running'].includes(latest?.status)) status = 'running';
  // dispatch_failed means the agent never started (e.g. stuck on an interactive prompt).
  else if (/fail/.test(latest?.status || '')) status = 'failed';
  else if (automation.nextRunAt && automation.nextRunAt < now - OVERDUE_MS) status = 'overdue';
  // skipped_precheck is a precheck saying there was nothing to do; its "error" isn't a failure.
  else if (/^skipped/.test(latest?.status || '')) status = 'skipped';
  else if (latest) status = latest.status;
  return {
    key: `${host.id}|${automation.id}`,
    id: automation.id,
    host: host.id,
    name: automation.name,
    enabled: automation.enabled,
    status,
    error: status === 'failed' ? clip(latest?.error, 300) : '',
    lastRunAt: latest?.startedAt || latest?.createdAt || null,
    nextRunAt: automation.enabled ? automation.nextRunAt || null : null,
    schedule: automation.rrule,
    timezone: automation.timezone
  };
}

async function readAutomations(orca) {
  const hosts = await Promise.all(
    HOSTS.map(async (host) => {
      try {
        const { automations } = await orca(['automations', 'list', ...host.args]);
        return Promise.all(
          automations.map(async (a) => {
            const runs = a.enabled ? (await orca(['automations', 'runs', '--id', a.id, ...host.args]).catch(() => ({ runs: [] }))).runs : [];
            return automationRow(host, a, runs);
          })
        );
      } catch (e) {
        return [{ key: `${host.id}|error`, host: host.id, name: `${host.label} automations`, status: 'unreadable', error: clip(e.message, 300) }];
      }
    })
  );
  const order = { failed: 0, overdue: 1, unreadable: 2, running: 3 };
  return hosts.flat().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));
}

// --- Status pages ------------------------------------------------------------------------------------------

function statusFromSummary(source, summary) {
  if (source.kind === 'stripe') {
    const ok = summary?.largestatus === 'up';
    const down = Object.entries(summary?.statuses || {}).filter(([, v]) => v !== 'up').map(([k, v]) => `${k}: ${v}`);
    return { name: source.name, url: source.page, ok, indicator: ok ? 'none' : 'major', detail: clip(down.join(' · ') || summary?.message || '', 300) };
  }
  if (source.kind === 'betteruptime') {
    const state = summary?.data?.attributes?.aggregate_state || 'unknown';
    return { name: source.name, url: source.page, ok: state === 'operational', indicator: state === 'operational' ? 'none' : state, detail: state === 'operational' ? '' : state.replace(/_/g, ' ') };
  }
  const watched = (c) => !source.components || source.components.test(c.name);
  const components = (summary?.components || []).filter((c) => !c.group && watched(c));
  const ids = new Set(components.map((c) => c.id));
  const incidents = (summary?.incidents || [])
    .filter((i) => i.status !== 'resolved' && i.status !== 'postmortem' && i.impact !== 'none')
    .filter((i) => !source.components || (i.components || []).some((c) => ids.has(c.id)));
  const broken = components.filter((c) => c.status !== 'operational');
  const indicator = source.components ? (broken.length || incidents.length ? 'minor' : 'none') : summary?.status?.indicator || 'unknown';
  return {
    name: source.name,
    url: incidents[0]?.shortlink || source.page,
    ok: indicator === 'none' && !incidents.length,
    indicator,
    detail: clip(incidents.map((i) => i.name).join(' · ') || broken.map((c) => `${c.name}: ${c.status.replace(/_/g, ' ')}`).join(' · ') || summary?.status?.description || '', 300)
  };
}

async function readStatusPages(fetchJson) {
  return Promise.all(
    STATUS_PAGES.map((s) =>
      fetchJson(s.url)
        .then((summary) => statusFromSummary(s, summary))
        .catch((e) => ({ name: s.name, url: s.page, ok: false, indicator: 'unreadable', detail: `Couldn't read the status page: ${clip(e.message, 120)}` }))
    )
  );
}

function monitorStatuses(monitors) {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  return Object.entries(VENDOR_MONITORS).map(([name, ids]) => {
    const found = ids.map((id) => byId.get(id)).filter(Boolean);
    const firing = found.filter((m) => ['Alert', 'Warn'].includes(m.overall_state));
    const missing = ids.length - found.length;
    return {
      name,
      source: 'datadog',
      url: `https://app.datadoghq.com/monitors/${(firing[0] || found[0])?.id || ids[0]}`,
      ok: !firing.length && !missing,
      indicator: firing.length ? 'alert' : missing ? 'unreadable' : 'none',
      detail: firing.map((m) => clip(m.name, 120)).join(' · ') || (missing ? `${missing} Datadog monitor(s) no longer exist` : '')
    };
  });
}

async function readMonitors(run = exec) {
  const { stdout } = await run('/opt/homebrew/bin/pup', ['monitors', 'list', '--no-agent'], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  return monitorStatuses(JSON.parse(stdout));
}

const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

// --- GitHub ------------------------------------------------------------------------------------------------

async function readReviewRequests(run = exec) {
  const { stdout } = await run('/opt/homebrew/bin/gh', [
    'search', 'prs', '--review-requested=@me', '--state=open', '--owner=gobranch', '--limit', '50',
    '--json', 'number,title,url,repository,updatedAt,isDraft,author'
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout)
    .filter((pr) => !pr.isDraft)
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, repo: pr.repository?.nameWithOwner, author: pr.author?.login, updatedAt: Date.parse(pr.updatedAt) || null }));
}

async function readEpic(number, run = exec) {
  const query = 'query($n:Int!){repository(owner:"gobranch",name:"branch"){issue(number:$n){title url state subIssuesSummary{total completed}}}}';
  const { stdout } = await run('/opt/homebrew/bin/gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `n=${number}`], { timeout: 30000 });
  const issue = JSON.parse(stdout).data.repository.issue;
  return { number, title: issue.title, url: issue.url, state: issue.state, total: issue.subIssuesSummary.total, completed: issue.subIssuesSummary.completed };
}

// --- Release watch -----------------------------------------------------------------------------------------

// triage.log lines: "2026-11-05 6:53pm #38078 fixes=3 design=5 vague=0 fixer=started", or "<date> FAILED slack: …".
function parseTriageLog(text) {
  const nights = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2})\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const counts = Object.fromEntries([...m[2].matchAll(/\b(\w+)=(\w+)/g)].map(([, k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v]));
    nights.push({
      date: m[1],
      failed: /\bFAILED\b/.test(m[2]),
      ticket: Number(/#(\d+)/.exec(m[2])?.[1]) || null,
      fixes: counts.fixes || 0,
      design: counts.design || 0,
      vague: counts.vague || 0,
      fixer: counts.fixer || null,
      counts,
      text: clip(m[2].trim(), 200)
    });
  }
  return nights;
}

async function readRelease(release, { host = runOnHost, run = exec } = {}) {
  const [logText, epic] = await Promise.all([
    host(`tail -n 60 ${release.log} 2>/dev/null || true`),
    release.epic ? readEpic(release.epic, run).catch(() => null) : null
  ]);
  const nights = parseTriageLog(logText);
  const last = nights.at(-1) || null;
  return { ...release, nights, last, epic, watcherFailed: Boolean(last?.failed) };
}

// --- Bug sweep ---------------------------------------------------------------------------------------------

function sweepDown(findings) {
  if (!findings) return [];
  const down = [];
  const sources = findings.lastRun?.sources || {};
  for (const [source, state] of Object.entries(sources)) {
    // A `partial: <reason>` source was read with reduced coverage; only `failed: <reason>` means unreadable.
    if (String(state).startsWith('failed')) down.push({ kind: 'sweep', title: `Bug sweep couldn't read ${source}`, detail: String(state), since: Date.parse(findings.lastRun.at) || null });
  }
  // Borderline findings sit below the sweep's filing bar on purpose; only fresh, filing-grade ones are urgent.
  const fresh = Date.now() - 3 * 86400000;
  for (const f of Object.values(findings.findings || {})) {
    const lastSeen = Math.max(0, ...(f.sources || []).map((s) => Date.parse(s.lastSeen) || 0));
    if (!f.ticket && !f.borderline && f.env === 'production' && lastSeen > fresh) {
      down.push({ kind: 'error', title: clip(f.title, 160), detail: 'Prod error with no ticket', url: f.sources?.[0]?.url || null, since: lastSeen || null });
    }
  }
  return down;
}

// --- Assembly ----------------------------------------------------------------------------------------------

const isFix = (title) => /^(hot)?fix\b|^\[?hotfix/i.test(title || '');

// One entry per vendor: a status page and Branch's own Datadog monitors on it combine.
function mergeVendors(checks) {
  const byName = new Map();
  for (const c of checks) {
    const prev = byName.get(c.name);
    if (!prev) byName.set(c.name, { ...c });
    else byName.set(c.name, {
      ...prev,
      ok: prev.ok && c.ok,
      indicator: prev.ok ? c.indicator : prev.indicator,
      url: prev.ok ? c.url : prev.url,
      detail: [prev.detail, c.detail].filter(Boolean).join(' · ')
    });
  }
  return [...byName.values()].sort((a, b) => a.ok - b.ok || a.name.localeCompare(b.name));
}

// Workspaces whose comment says an agent is on it, but nothing is running there or in its parent.
// Automation-owned statuses (Daily process, Automations) are left to the automations that own them.
// shortcut: any running agent in the parent covers its children, so a busy parent can hide a stalled child; match on dispatches if that bites.
const STALL_MS = 30 * 60000;
const AUTOMATION_STATUSES = new Set(['status-5', 'status-8']);
function stalled(workspaces, now) {
  const running = (w) => (w.agents || []).some((a) => a.state !== 'done') || (!(w.agents || []).length && w.live > 0);
  const byKey = new Map(workspaces.map((w) => [w.key, w]));
  return workspaces.filter((w) => /^Agent:/i.test(w.comment) && !AUTOMATION_STATUSES.has(w.status)
    && now - (w.lastActivityAt || now) > STALL_MS && !running(w) && !(byKey.has(w.parent) && running(byKey.get(w.parent))));
}

function assemble({ automations, statuses, monitors = { value: [] }, reviews, map, ease, merge, releases, findings, jobs, now = Date.now() }) {
  const down = [];
  const vendors = mergeVendors([...(statuses.value || []), ...(monitors.value || [])]);
  for (const s of vendors) {
    const label = { minor: 'degraded', major: 'major outage', critical: 'outage', alert: 'Datadog alert', unreadable: 'status unknown' }[s.indicator] || 'not operational';
    if (!s.ok) down.push({ kind: 'vendor', title: `${s.name}: ${label}`, detail: s.detail, url: s.url });
  }
  for (const a of automations.value || []) {
    if (['failed', 'overdue', 'unreadable'].includes(a.status)) {
      down.push({ kind: 'automation', title: `${a.name} ${a.status === 'overdue' ? 'missed its run' : a.status === 'failed' ? 'failed' : 'unreadable'}`, detail: a.error || `${a.host === 'vm' ? 'VM' : 'Mac'} automation`, since: a.lastRunAt });
    }
  }
  for (const r of releases.value || []) {
    if (r.watcherFailed) down.push({ kind: 'automation', title: `${r.name} feedback watcher failed`, detail: r.last.text });
  }
  down.push(...sweepDown(findings.value));

  const ready = (merge.value?.ready || []).map((pr) => ({ ...pr, fix: isFix(pr.title) })).sort((a, b) => b.fix - a.fix || a.number - b.number);

  const workspaces = (map.value?.hosts || []).flatMap((h) => h.workspaces);
  // Ease posts have their own group; don't list their workspaces twice.
  const easeWorkspaces = new Set((ease.value?.posts || []).map((p) => p.workspace?.name).filter(Boolean));
  const agents = workspaces
    .filter((w) => /^You:/i.test(w.comment) && !easeWorkspaces.has(w.name))
    .map((w) => ({ key: w.key, host: w.host, name: w.name, ask: w.comment.replace(/^You:\s*/i, ''), pr: w.pr, at: w.lastActivityAt }))
    .concat(stalled(workspaces, now).map((w) => ({ key: w.key, host: w.host, name: w.name, ask: `Restart or update: no agent behind "${clip(w.comment, 60)}"`, pr: w.pr, at: w.lastActivityAt, stalled: true })))
    .sort((a, b) => b.at - a.at);
  const easeYou = (ease.value?.posts || []).filter((p) => p.whose === 'you').map((p) => {
    const action = (p.actions || []).find((a) => a.state === 'open');
    return { title: p.title, link: p.link, next: action?.text || p.workspace?.comment?.replace(/^You:\s*/i, '') || '', nextUrl: action?.url || null };
  });
  const drafts = (jobs.value || []).filter((j) => j.hasInbox && j.unread).map((j) => ({ name: j.name, unread: j.unread }));

  const errors = Object.entries({ automations, statuses, monitors, reviews, map, ease, merge, releases, findings, jobs })
    .filter(([, r]) => r.error)
    .map(([source, r]) => ({ source, error: clip(r.error, 300) }));
  for (const h of map.value?.hosts || []) if (h.error) errors.push({ source: `map (${h.label})`, error: h.error });
  if (ease.value?.mapError) errors.push({ source: 'ease', error: ease.value.mapError });
  if (merge.value?.error) errors.push({ source: 'merge', error: merge.value.error });

  return {
    refreshedAt: Date.now(),
    down,
    vendors,
    unwatched: UNWATCHED,
    ready,
    waitingPrs: merge.value?.waiting || [],
    blocked: { agents, reviews: reviews.value || [], ease: easeYou, drafts },
    releases: releases.value || [],
    automations: automations.value || [],
    errors
  };
}

const settle = (promise) => Promise.resolve().then(promise).then((value) => ({ value }), (e) => ({ error: e?.message || String(e) }));

function createNowReader({ readMap, readEase, readMerge, readFindings, readJobs, orca = orcaRunner(), getJson = fetchJson, run = exec, host = runOnHost }, ttl = 60000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= Promise.all([
      settle(() => readAutomations(orca)),
      settle(() => readStatusPages(getJson)),
      settle(() => readMonitors(run)),
      settle(() => readReviewRequests(run)),
      settle(readMap),
      settle(readEase),
      settle(readMerge),
      settle(() => Promise.all(RELEASES.map((r) => readRelease(r, { host, run })))),
      settle(readFindings),
      settle(readJobs)
    ])
      .then(([automations, statuses, monitors, reviews, map, ease, merge, releases, findings, jobs]) =>
        (cached = assemble({ automations, statuses, monitors, reviews, map, ease, merge, releases, findings, jobs })))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { automationRow, statusFromSummary, monitorStatuses, mergeVendors, parseTriageLog, sweepDown, stalled, assemble, isFix, createNowReader, STATUS_PAGES, RELEASES };
