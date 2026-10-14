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
function timestamp(time) {
  return time
    ? new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'No timestamp';
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
        job.schedule ? `${job.schedule.length === 5 ? 'Daily at ' : ''}${job.schedule}` : 'Schedule unavailable',
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
async function refresh() {
  if (state.refreshing) {
    return;
  }
  state.refreshing = true;
  $('refresh').disabled = true;
  try {
    const result = await api('status');
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
      `Updated ${new Date(result.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
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
async function openView(label, type, name = null) {
  state.view = { label, type, name, kind: 'runs' };
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
    const data = await api('log', { job: job.label, kind: view.kind });
    title = 'Run logs';
    for (const [kind, name] of [
      ['runs', 'Run history'],
      ['output', 'Agent output'],
      ['errors', job.source === 'orca' ? 'Run errors' : 'Launcher errors']
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
    content.push(
      element(
        'p',
        job.source === 'orca'
          ? `${data.name} · Updates every 10 seconds. Read the result for findings or failures; a finished run doesn’t confirm the work succeeded.${data.truncated ? ' Output is truncated.' : ''}`
          : `${data.name} · ${data.truncated ? 'Last 64 KB' : 'Full file'} · Updates every 10 seconds. Exit 0 means the process exited successfully; check the log for its outcome.`,
        'note'
      ),
      element('pre', data.text || 'No output yet.', 'log')
    );
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
        `Draft ${draft.n} · ${draft.title}`,
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
