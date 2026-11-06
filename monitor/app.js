const $ = (id) => document.getElementById(id);
const state = { jobs: [], view: null, refreshing: false, updatedAt: null };
const labels = {
  ok: 'Exit 0',
  running: 'Running',
  failed: 'Failed',
  overdue: 'Log overdue',
  unknown: 'Check status',
  waiting: 'Not run yet',
  completed: 'Run finished',
  paused: 'Paused',
  skipped: 'Skipped',
  cancelled: 'Stopped'
};
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function age(time) {
  if (!time) {
    return 'Unavailable';
  }
  const minutes = Math.round((time - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) {
    return relative.format(minutes, 'minute');
  }
  if (Math.abs(minutes) < 1440) {
    return relative.format(Math.round(minutes / 60), 'hour');
  }
  return relative.format(Math.round(minutes / 1440), 'day');
}
// 12-hour times read "12:04pm": lowercase am/pm with no space (Intl uses a narrow no-break space).
const lowerMeridiem = (text) => text.replace(/[\s\u202f]*([AP])M$/i, (match, letter) => `${letter.toLowerCase()}m`);
function timestamp(time) {
  return time
    ? lowerMeridiem(new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    : 'No timestamp';
}
// The server sends schedules as 24-hour "HH:MM", e.g. "Daily at 12:04 · America/New_York".
function scheduleText(schedule) {
  return (schedule.length === 5 ? `Daily at ${schedule}` : schedule).replace(
    /\b(\d{2}):(\d{2})\b/,
    (match, hour, minute) => `${Number(hour) % 12 || 12}:${minute}${Number(hour) < 12 ? 'am' : 'pm'}`
  );
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
}
function button(text, action, className = 'secondary') {
  const node = element('button', text, className);
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action(node);
    } catch (error) {
      showError(error.message);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}
async function api(route, params = {}, options = {}) {
  const response = await fetch(`/api/${route}?${new URLSearchParams(params)}`, {
    ...options,
    signal: AbortSignal.timeout(route === 'post' ? 90000 : 12000)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'Couldn’t load monitor data.');
  }
  return result;
}
function metric(title, time) {
  const wrapper = element('div');
  const dd = element('dd');
  const value = element('span', age(time));
  value.dataset.relativeTime = time || '';
  dd.append(value, element('small', timestamp(time)));
  wrapper.append(element('dt', title), dd);
  return wrapper;
}
function renderJobs() {
  const cards = state.jobs.map((job) => {
    const card = element('article', null, 'job');
    const top = element('div', null, 'card-top');
    const title = element('div');
    title.append(
      element('h2', job.name),
      element(
        'p',
        job.schedule ? scheduleText(job.schedule) : 'Schedule unavailable',
        'schedule'
      )
    );
    top.append(title, element('span', labels[job.status], `status ${job.status}`));
    const metrics = element('dl', null, 'metrics');
    metrics.append(
      metric(
        job.source === 'orca' ? 'Last run started' : 'Last log activity',
        job.source === 'orca' ? job.lastRunAt : job.lastLogAt
      ),
      metric('Next scheduled run', job.nextRunAt)
    );
    const review = element('p', null, 'review-line');
    if (job.hasInbox) {
      review.append(
        element('span', String(job.unread), 'count'),
        element('span', job.unread ? `${job.unread === 1 ? 'file needs' : 'files need'} review` : 'Inbox reviewed')
      );
    } else {
      review.textContent = 'No draft inbox configured';
    }
    const actions = element('div', null, 'actions');
    actions.append(button('View logs', () => openView(job.label, 'log'), 'text'));
    if (job.hasInbox) {
      actions.append(button('Inbox', () => openView(job.label, 'inbox'), 'text'));
    }
    if (job.hasFindings) {
      actions.append(button('Findings', () => openView(job.label, 'findings'), 'primary'));
    }
    if (job.latestDraft) {
      actions.append(button('Latest drafts', () => openView(job.label, 'file', job.latestDraft), 'primary'));
    }
    card.append(top, metrics);
    if (job.warnings.length) {
      card.append(element('p', job.warnings.join(' '), 'warning'));
    }
    if (job.status === 'failed' && job.source !== 'orca') {
      card.append(element('p', `Last process exit code: ${job.exit}. Check the logs for details.`, 'warning'));
    }
    if (job.status === 'overdue') {
      card.append(element('p', 'No run-log update since the scheduled time (15-minute grace period).', 'warning'));
    }
    card.append(review, actions);
    return card;
  });
  $('jobs').replaceChildren(...cards);
}
function pilotReport(text) {
  const container = element('div', null, 'pilot-report');
  let table;
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (!table) {
        const scroll = element('div', null, 'pilot-table-scroll');
        table = element('table');
        scroll.append(table);
        container.append(scroll);
      }
      const row = element('tr');
      cells.forEach((cell) => row.append(element(table.children.length ? 'td' : 'th', cell)));
      table.append(row);
    } else {
      table = null;
      if (line.startsWith('#')) container.append(element('h3', line.replace(/^#+\s*/, '')));
      else if (line.trim()) container.append(element('p', line));
    }
  }
  return container;
}
function renderPilot(pilot) {
  const card = $('pilot');
  if (pilot.status === 'unavailable') {
    card.hidden = false;
    card.replaceChildren(element('h2', 'Shared reader pilot'), element('p', 'Pilot status or report unavailable.', 'warning'));
    return;
  }
  const top = element('div', null, 'card-top');
  const heading = element('div');
  heading.append(element('h2', 'Shared reader pilot'), element('p', 'Synthetic comparisons · Claude + Codex · Mac + cloud', 'schedule'));
  top.append(heading, element('span', pilot.attention ? 'Needs attention' : pilot.status === 'finalized' ? 'Final report' : 'In progress', `status ${pilot.attention ? 'waiting' : 'running'}`));
  const start = Date.parse(pilot.startedAt);
  const dates = element('p', pilot.status === 'finalized'
    ? `Final report: ${timestamp(Date.parse(pilot.finalizedAt))}`
    : `Repeats after ${timestamp(start + 7 * 86400000)} · Final report after ${timestamp(start + 14 * 86400000)}`, 'pilot-dates');
  const details = element('details');
  details.append(element('summary', 'View comparison and delivery status'), pilotReport(pilot.report));
  card.replaceChildren(top, dates, details);
  card.hidden = false;
}
async function refresh() {
  if (state.refreshing) {
    return;
  }
  state.refreshing = true;
  $('refresh').disabled = true;
  try {
    const [result, pilot] = await Promise.all([api('status'), api('shared-reader')]);
    if (JSON.stringify(state.pilot) !== JSON.stringify(pilot)) {
      state.pilot = pilot;
      renderPilot(pilot);
    }
    // Keep focused buttons stable when nothing has changed.
    if (JSON.stringify(state.jobs) !== JSON.stringify(result.jobs)) {
      state.jobs = result.jobs;
      renderJobs();
    }
    for (const node of document.querySelectorAll('[data-relative-time]')) {
      node.textContent = age(Number(node.dataset.relativeTime));
    }
    state.updatedAt = result.updatedAt;
    $('connection').textContent =
      `Updated ${lowerMeridiem(new Date(result.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}`;
    $('timezone').textContent = result.timezone;
    $('error').hidden = true;
    if (state.view && ['log', 'inbox'].includes(state.view.type)) {
      await renderView(state.view);
    }
  } catch (error) {
    $('connection').textContent = state.updatedAt
      ? `Disconnected · last update ${timestamp(state.updatedAt)}`
      : 'Monitor disconnected';
    showError(`${error.message} Use Refresh to try again.`);
  } finally {
    state.refreshing = false;
    $('refresh').disabled = false;
  }
}
const sourceNames = { datadog: 'Datadog', sentry: 'Sentry', logrocket: 'LogRocket' };
const countNames = {
  issuesSeen: 'issues seen',
  sessionsReviewed: 'sessions reviewed',
  routesReviewed: 'routes reviewed',
  filed: 'filed',
  correlated: 'correlated'
};
const fixLabels = { none: 'No fix yet', pr: 'PR open', 'not-simple': 'Not simple', blocked: 'Blocked', merged: 'Merged' };
// Reuses the status badge colors: green, blue, amber, red.
const fixClasses = { pr: 'status running', merged: 'status', 'not-simple': 'status waiting', blocked: 'status failed' };
const quietAfter = 14 * 24 * 60 * 60 * 1000;
function externalLink(text, url, className) {
  const node = element('a', text, className);
  if (/^https:\/\//.test(url)) {
    node.href = url;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  return node;
}
function seenRange(finding) {
  const times = (finding.sources || []).flatMap((source) => [Date.parse(source.firstSeen), Date.parse(source.lastSeen)]);
  const known = times.filter(Number.isFinite);
  return known.length ? { first: Math.min(...known), last: Math.max(...known) } : {};
}
function showShot(src, alt) {
  let dialog = $('shot-dialog');
  if (!dialog) {
    dialog = element('dialog', null, 'shot-dialog');
    dialog.id = 'shot-dialog';
    dialog.setAttribute('aria-label', 'Screenshot');
    dialog.append(element('img'));
    // Click anywhere to close; Esc works natively.
    dialog.addEventListener('click', () => dialog.close());
    document.body.append(dialog);
  }
  const image = dialog.querySelector('img');
  image.src = src;
  image.alt = alt;
  dialog.showModal();
}
function thumbnail(job, finding) {
  const cell = element('td', null, 'shot-cell');
  if (!finding.screenshot) {
    cell.append(element('span', 'No screenshot', 'shot-empty'));
    return cell;
  }
  const src = `/api/shot?${new URLSearchParams({ job: job.label, name: finding.screenshot })}`;
  const image = element('img');
  image.src = src;
  image.alt = '';
  image.loading = 'lazy';
  // Screenshots are deleted after 14 days, so a missing file is expected.
  image.addEventListener('error', () => cell.replaceChildren(element('span', 'Screenshot removed', 'shot-empty')));
  const open = button(null, () => showShot(src, 'Screenshot from the sessions behind this finding'), 'thumb');
  open.setAttribute('aria-label', 'View screenshot full size');
  open.append(image);
  cell.append(open);
  return cell;
}
// "route — file:line; file:line" reads better with one path per line.
function breakable(text, className) {
  const line = element('div', null, className);
  // Offer a break after each slash so paths wrap between folders, not mid-name.
  text.split(/(?<=\/)/).forEach((part, index) => {
    if (index) {
      line.append(document.createElement('wbr'));
    }
    line.append(document.createTextNode(part));
  });
  return line;
}
function whereLines(where) {
  const [route, ...files] = String(where || '—').split(' — ');
  return [
    breakable(route, 'where-route'),
    ...files
      .join(' — ')
      .split('; ')
      .filter(Boolean)
      .map((file) => breakable(file))
  ];
}
function findingRow(job, finding) {
  const row = element('tr');
  const name = element('td', null, 'finding-cell');
  const fullTitle = String(finding.title || finding.key || 'Untitled finding');
  const title = element('div', fullTitle.replace(/^\[Bug AI Automation\]\s*/, ''), 'finding-title');
  title.title = fullTitle;
  const inlineWhere = element('div', null, 'where where-inline');
  inlineWhere.append(...whereLines(finding.where));
  inlineWhere.hidden = !finding.where;
  name.append(title, element('div', String(finding.key ?? ''), 'finding-key'), inlineWhere);
  const where = element('td', null, 'where');
  where.append(...whereLines(finding.where));
  const sources = element('td', null, 'badges');
  for (const source of finding.sources || []) {
    const label = String(source.countLabel ?? '');
    sources.append(
      externalLink(
        `${sourceNames[source.type] || source.type} · ${source.count} ${source.count === 1 ? label.replace(/^(\w+)s(?=\/|$)/, '$1') : label}`,
        source.url,
        'source-badge'
      )
    );
  }
  const { first, last } = seenRange(finding);
  const seen = element('td', null, 'seen');
  for (const [label, time] of [['First', first], ['Last', last]]) {
    const line = element('div', null, 'seen-line');
    line.append(element('span', label), element('span', time ? age(time) : 'Unavailable'));
    line.title = timestamp(time);
    seen.append(line);
  }
  const ticket = element('td');
  ticket.append(
    Number.isInteger(finding.ticket)
      ? externalLink(`#${finding.ticket}`, `https://github.com/gobranch/branch/issues/${finding.ticket}`)
      : element('span', '—', 'muted')
  );
  const fix = element('td', null, 'fix-cell');
  const status = finding.fix?.status || 'none';
  if (status === 'none') {
    fix.append(element('span', '—', 'muted'));
  } else {
    const label = fixLabels[status] || String(status);
    fix.append(
      finding.fix.url ? externalLink(label, finding.fix.url, fixClasses[status]) : element('span', label, fixClasses[status])
    );
    if (finding.fix.reason) {
      fix.append(element('div', finding.fix.reason, 'fix-reason'));
    }
  }
  row.append(
    thumbnail(job, finding),
    name,
    where,
    sources,
    seen,
    ticket,
    fix
  );
  return row;
}
function findingsTable(job, findings) {
  const head = element('tr');
  for (const heading of ['Screenshot', 'Finding', 'Where', 'Sources', 'Seen', 'Ticket', 'Fix']) {
    head.append(element('th', heading, heading === 'Where' ? 'where' : ''));
  }
  const table = element('table', null, 'findings');
  const thead = element('thead');
  const tbody = element('tbody');
  thead.append(head);
  tbody.append(
    ...findings.map((finding) => {
      try {
        return findingRow(job, finding);
      } catch {
        // One malformed record shouldn't blank the whole table.
        const row = element('tr');
        const cell = element('td', `Couldn’t display the record ${finding?.key ?? ''}.`, 'muted');
        cell.colSpan = 7;
        row.append(cell);
        return row;
      }
    })
  );
  table.append(thead, tbody);
  const wrap = element('div', null, 'table-wrap');
  wrap.append(table);
  return wrap;
}
function runSummary(run) {
  const summary = element('div', null, 'run-summary');
  if (!run) {
    summary.append(element('p', 'No run recorded yet.', 'note'));
    return summary;
  }
  const time = Date.parse(run.at);
  const line = element('p', null, 'run-line');
  line.append(
    element('strong', `Last run ${timestamp(time)}`),
    element('span', age(time), 'muted'),
    element('span', run.mode, 'count')
  );
  const badges = element('div', null, 'badges');
  const failed = [];
  // Every source gets a badge: one the run didn't report is a gap, not a clean result.
  for (const type of new Set([...Object.keys(sourceNames), ...Object.keys(run.sources || {})])) {
    const name = sourceNames[type] || type;
    const missing = run.sources?.[type] == null;
    const result = missing ? 'missing' : String(run.sources[type]);
    const kind = missing || result.startsWith('failed') ? 'failed' : result.startsWith('partial') ? 'partial' : 'ok';
    if (kind === 'failed') {
      failed.push(`${name} (${missing ? 'not reported' : result.replace(/^failed:\s*/, '')})`);
    }
    badges.append(element('span', `${name} · ${result}`, `status ${{ ok: '', partial: 'waiting', failed: 'failed strong' }[kind]}`));
  }
  const counts = element('p', null, 'run-counts');
  for (const [key, value] of Object.entries(run.counts || {})) {
    const item = element('span');
    item.append(element('span', String(value), 'count'), document.createTextNode(` ${countNames[key] || key}`));
    counts.append(item);
  }
  summary.append(line, badges, counts);
  if (failed.length) {
    summary.append(
      element('p', `${failed.join(', ')} couldn’t be checked in this run, so findings from there may be missing.`, 'error')
    );
  }
  return summary;
}
function findingsView(job, data) {
  const nodes = [runSummary(data.lastRun)];
  if (!data.findings.length) {
    nodes.push(element('p', 'No findings yet.', 'note'));
    return nodes;
  }
  const filters = element('div', null, 'filters');
  const makeFilter = (label, options) => {
    const wrapper = element('label', label, 'filter');
    const select = element('select');
    for (const [value, text] of options) {
      const option = element('option', text);
      option.value = value;
      select.append(option);
    }
    wrapper.append(select);
    filters.append(wrapper);
    return select;
  };
  const sourceFilter = makeFilter('Source', [['', 'All sources'], ...Object.entries(sourceNames)]);
  const fixFilter = makeFilter('Fix status', [['', 'All'], ...Object.entries(fixLabels)]);
  const open = element('div', null, 'open-findings');
  const sections = [
    ['Resolved or quiet', (finding) => !finding.borderline && isQuiet(finding)],
    ['Borderline, not filed', (finding) => finding.borderline]
  ].map(([name, test]) => {
    const details = element('details');
    const summary = element('summary');
    const body = element('div');
    details.append(summary, body);
    return { name, test, details, summary, body };
  });
  function isQuiet(finding) {
    const { last } = seenRange(finding);
    return finding.fix?.status === 'merged' || (last != null && Date.now() - last > quietAfter);
  }
  function draw() {
    const visible = data.findings.filter(
      (finding) =>
        (!sourceFilter.value || (finding.sources || []).some((source) => source.type === sourceFilter.value)) &&
        (!fixFilter.value || (finding.fix?.status || 'none') === fixFilter.value)
    );
    const rest = visible.filter((finding) => !sections.some((section) => section.test(finding)));
    open.replaceChildren(
      rest.length
        ? findingsTable(job, rest)
        : element('p', visible.length ? 'No open findings.' : 'No findings match these filters.', 'note')
    );
    for (const section of sections) {
      const rows = visible.filter(section.test);
      section.summary.textContent = `${section.name} (${rows.length})`;
      section.body.replaceChildren(...(rows.length ? [findingsTable(job, rows)] : []));
      section.details.hidden = !rows.length;
    }
  }
  sourceFilter.addEventListener('change', draw);
  fixFilter.addEventListener('change', draw);
  draw();
  nodes.push(filters, open, ...sections.map((section) => section.details));
  return nodes;
}
async function openView(label, type, name = null, kind = 'runs') {
  state.view = { label, type, name, kind };
  $('viewer').hidden = false;
  $('viewer-content').replaceChildren(element('p', 'Loading…', 'note'));
  await renderView(state.view);
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function markReviewed(job, files, node) {
  await api(
    'review',
    { job: job.label },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
      body: JSON.stringify({ files })
    }
  );
  node.textContent = 'Reviewed';
  await refresh();
  if (state.view?.type === 'inbox') {
    await renderView(state.view);
  }
}
async function renderView(view) {
  const job = state.jobs.find((item) => item.label === view.label);
  if (!job) {
    return;
  }
  const tools = [];
  const content = [];
  let title;
  $('viewer-job').textContent = job.name;
  if (view.type === 'log') {
    // fix.log doesn't exist until a fixer has run, so show it as empty.
    const data = await api('log', { job: job.label, kind: view.kind }).catch((error) => {
      if (view.kind !== 'fix') {
        throw error;
      }
      return { name: 'fix.log', text: '' };
    });
    title = view.kind === 'fix' ? 'Fix log' : 'Run logs';
    for (const [kind, name] of [
      ['runs', 'Run history'],
      ['output', 'Agent output'],
      ['errors', job.source === 'orca' ? 'Run errors' : 'Launcher errors'],
      ...(job.hasFindings ? [['fix', 'Fix log']] : [])
    ]) {
      tools.push(
        button(
          name,
          async () => {
            state.view = { ...view, kind };
            await renderView(state.view);
          },
          kind === view.kind ? 'primary' : 'text'
        )
      );
    }
    if (job.hasFindings) {
      tools.unshift(button('Findings', () => openView(job.label, 'findings'), 'text'));
    }
    content.push(
      element(
        'p',
        job.source === 'orca' && view.kind !== 'fix'
          ? `${data.name} · Updates every 10 seconds. Read the result for findings or failures; a finished run doesn’t confirm the work succeeded.${data.truncated ? ' Output is truncated.' : ''}`
          : `${data.name} · ${data.truncated ? 'Last 64 KB' : 'Full file'} · Updates every 10 seconds.${view.kind === 'fix' ? '' : ' Exit 0 means the process exited successfully; check the log for its outcome.'}`,
        'note'
      ),
      element('pre', data.text || 'No output yet.', 'log')
    );
  } else if (view.type === 'findings') {
    title = 'Findings';
    tools.push(
      button('Run log', () => openView(job.label, 'log'), 'text'),
      button('Fix log', () => openView(job.label, 'log', null, 'fix'), 'text')
    );
    try {
      content.push(...findingsView(job, await api('findings', { job: job.label })));
    } catch (error) {
      // Keep the error in the viewer; the status poll hides the page banner.
      content.push(element('p', error.message, 'error'));
    }
  } else if (view.type === 'inbox') {
    title = 'Draft inbox';
    content.push(
      element(
        'p',
        'New and changed files stay unread until you mark them reviewed. Review status is shared with Panopticlaude in VS Code.',
        'note'
      )
    );
    const unread = job.files.filter((file) => file.unread);
    if (unread.length) {
      tools.push(
        button(`Mark ${unread.length} ${unread.length === 1 ? 'file' : 'files'} reviewed`, (node) =>
          markReviewed(job, unread, node)
        )
      );
    }
    if (!job.files.length) {
      content.push(element('p', 'No drafts yet.', 'note'));
    }
    for (const file of job.files) {
      const row = element('div', null, 'file-row');
      const meta = element('div', null, 'file-meta');
      meta.append(
        element('span', timestamp(file.mtime)),
        element('span', file.unread ? 'New' : 'Reviewed', file.unread ? 'count' : '')
      );
      row.append(
        button(file.name, () => openView(job.label, 'file', file.name), 'text'),
        meta
      );
      content.push(row);
    }
  } else {
    const data = await api('file', { job: job.label, name: view.name });
    title = data.name;
    tools.push(
      button('Back to inbox', () => openView(job.label, 'inbox'), 'text'),
      button('Mark reviewed', (node) => markReviewed(job, [{ name: data.name, mtime: data.mtime }], node))
    );
    content.push(
      element(
        'p',
        data.posted
          ? 'This file is marked as posted. Check the source notes before reusing any comments.'
          : 'Expand a draft to review its comment. Post sends it to the linked issue as ticket-automation[bot].',
        'note'
      )
    );
    for (const draft of data.drafts) {
      const card = element('article', null, 'draft');
      const heading = element('div', null, 'draft-heading');
      const preview = element('div', null, 'draft-preview');
      const body = draft.html ? element('div', null, 'markdown') : element('pre', draft.body);
      if (draft.html) {
        body.innerHTML = draft.html;
        for (const link of body.querySelectorAll('a')) {
          link.target = '_blank';
          link.rel = 'noopener';
        }
      }
      body.id = `draft-body-${data.drafts.indexOf(draft)}`;
      body.hidden = true;
      const h3 = element('h3');
      const toggle = button(
        draft.posting?.status === 'posted' ? draft.title : `Draft ${draft.n} · ${draft.title}`,
        () => {
          body.hidden = !body.hidden;
          toggle.setAttribute('aria-expanded', String(!body.hidden));
        },
        'draft-toggle'
      );
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', body.id);
      h3.append(toggle);
      preview.append(h3);
      if (job.repo) {
        const link = element('a', `#${draft.issue}`);
        link.href = `https://github.com/${job.repo}/issues/${draft.issue}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        preview.append(link);
      } else {
        preview.append(document.createTextNode(`#${draft.issue}`));
      }
      const actions = element('div', null, 'draft-actions');
      actions.append(
        button(
          'Copy comment',
          async (node) => {
            await navigator.clipboard.writeText(draft.body);
            node.textContent = 'Copied';
          },
          'text'
        )
      );
      const result = element('p', '', 'note post-result');
      result.hidden = true;
      result.setAttribute('role', 'status');
      const post = button(
        'Post',
        async (node) => {
          node.textContent = 'Posting…';
          result.hidden = true;
          result.classList.remove('post-failed');
          try {
            const posted = await api(
              'post',
              { job: job.label },
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
                body: JSON.stringify({ name: data.name, version: data.version, n: draft.n })
              }
            );
            showPosted(posted);
          } catch (error) {
            node.textContent = 'Post';
            result.textContent = error.message;
            result.classList.add('post-failed');
            result.hidden = false;
          }
        },
        'primary'
      );
      function showPosted(posted) {
        toggle.textContent = draft.title;
        post.hidden = true;
        skip.hidden = true;
        skipForm.hidden = true;
        card.classList.remove('skipping');
        const link = element('a', 'Posted · View comment');
        const issueUrl = `https://github.com/${job.repo}/issues/${draft.issue}`;
        link.href = posted.commentUrl?.startsWith(`${issueUrl}#issuecomment-`) ? posted.commentUrl : issueUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        result.replaceChildren(link);
        result.hidden = false;
      }
      const skipForm = element('form', null, 'skip-form');
      skipForm.hidden = true;
      const skipSummary = element('p', '', 'note skip-summary');
      skipSummary.hidden = true;
      const fieldset = element('fieldset');
      fieldset.append(element('legend', 'Why aren’t you posting this?'));
      const boxes = Object.entries(data.skipReasons).map(([key, label]) => {
        const option = element('label', null, 'skip-option');
        const box = element('input');
        box.type = 'checkbox';
        box.value = key;
        box.checked = Boolean(draft.skipped?.reasons.includes(key));
        option.append(box, document.createTextNode(label));
        fieldset.append(option);
        return box;
      });
      const noteLabel = element('label', 'Anything else? (optional)', 'skip-note');
      const note = element('textarea');
      note.rows = 3;
      note.maxLength = 4000;
      note.value = draft.skipped?.note || '';
      noteLabel.append(note);
      const skipError = element('p', '', 'note post-result post-failed');
      skipError.hidden = true;
      skipError.setAttribute('role', 'alert');
      const save = element('button', 'Save reason', 'primary');
      save.type = 'submit';
      skipForm.append(fieldset, noteLabel, skipError, save);
      function showSkipped(feedback) {
        const reasons = feedback.reasons.map((key) => data.skipReasons[key] || key);
        skipSummary.textContent = `Not posting: ${[...reasons, feedback.note].filter(Boolean).join(' · ')}`;
        skipSummary.hidden = false;
        skip.textContent = 'Edit reason';
      }
      skipForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        skipError.hidden = true;
        try {
          const feedback = await api(
            'skip',
            { job: job.label },
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Panopticlaude': '1' },
              body: JSON.stringify({
                name: data.name,
                version: data.version,
                n: draft.n,
                reasons: boxes.filter((box) => box.checked).map((box) => box.value),
                note: note.value
              })
            }
          );
          draft.skipped = feedback;
          skipForm.hidden = true;
          card.classList.remove('skipping');
          showSkipped(feedback);
        } catch (error) {
          skipError.textContent = error.message;
          skipError.hidden = false;
        } finally {
          save.disabled = false;
        }
      });
      const skip = button(
        'Not posting',
        () => {
          skipForm.hidden = !skipForm.hidden;
          card.classList.toggle('skipping', !skipForm.hidden);
          if (!skipForm.hidden) {
            // Keep the draft beside the reasons so it can be reread while choosing.
            body.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            boxes[0]?.focus();
          }
        },
        'text'
      );
      if (draft.skipped) {
        showSkipped(draft.skipped);
      }
      skip.hidden = draft.posting?.status === 'posted';
      actions.append(skip);
      post.disabled = !job.repo || data.posted;
      if (draft.posting?.status === 'posted') {
        showPosted(draft.posting);
      } else if (draft.posting?.status === 'pending') {
        post.textContent = 'Check post';
        result.textContent =
          'The last post wasn’t confirmed. Check post looks for the comment without sending it again.';
        result.hidden = false;
      }
      actions.append(post);
      heading.append(preview, actions);
      const bodyRow = element('div', null, 'draft-body-row');
      bodyRow.append(body, skipForm);
      card.append(heading, result, skipSummary, bodyRow);
      content.push(card);
    }
    if (data.drafts.length) {
      const details = element('details');
      details.append(element('summary', 'Full source and run notes'), element('pre', data.text, 'log'));
      content.push(details);
    } else {
      content.push(element('pre', data.text, 'log'));
    }
  }
  // A slow request must not overwrite a newer tab selection or reopen a closed view.
  if (state.view !== view) {
    return;
  }
  $('viewer-job').textContent = job.name;
  $('viewer-title').textContent = title;
  $('viewer-tools').replaceChildren(...tools);
  const scrollTop = $('viewer-content').querySelector('.log')?.scrollTop || 0;
  $('viewer-content').replaceChildren(...content);
  if (view.type === 'log') {
    $('viewer-content').querySelector('.log').scrollTop = scrollTop;
  }
}
$('refresh').addEventListener('click', refresh);
$('close').addEventListener('click', () => {
  state.view = null;
  $('viewer').hidden = true;
});
refresh();
setInterval(refresh, 10000);
