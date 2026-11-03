/* Cached, read-only GitHub ticket view. */
(function () {
  'use strict';
  const openActions = ticket => (ticket.actions || []).filter(action => action.state === 'open');
  const isOpen = pr => String(pr.state).toUpperCase() === 'OPEN';
  const isMerged = pr => String(pr.state).toUpperCase() === 'MERGED';
  function stage(ticket) {
    const prs = ticket.prs || [];
    if (prs.some(pr => isOpen(pr) && !pr.isDraft)) return 'Open PR';
    if (prs.some(isOpen)) return 'Draft PR';
    if (prs.some(isMerged)) return 'Merged PR';
    if (String(ticket.state).toUpperCase() === 'CLOSED') return 'Closed issue';
    if (prs.length && prs.every(pr => String(pr.state).toUpperCase() === 'CLOSED')) return 'Closed PR';
    return 'No PR';
  }
  function archived(ticket) {
    return ['Merged PR', 'Closed issue', 'Closed PR'].includes(stage(ticket)) && !openActions(ticket).length;
  }
  function actionText(ticket) {
    return ticket.nextAction || openActions(ticket)[0]?.text || (archived(ticket) ? 'Review history' : 'Needs assessment');
  }
  function rank(ticket) {
    if (Number.isFinite(ticket.nextActionRank)) return ticket.nextActionRank;
    const text = actionText(ticket);
    if (/fail|broken/i.test(text)) return 0;
    if (/decision|clarif|block|depend/i.test(text)) return 1;
    if (/^wait|^await|pending/i.test(text)) return 4;
    if (/review|verif/i.test(text)) return 2;
    return 3;
  }
  function filterTickets(tickets, filters = {}) {
    const search = (filters.search || '').trim().toLowerCase().replace(/^#/, '');
    return tickets.filter(ticket => (!filters.project || (ticket.projects || []).includes(filters.project)) &&
      (!filters.category || (ticket.category || 'Unknown') === filters.category) &&
      (!filters.owner || (ticket.owner || 'Owner needed') === filters.owner) &&
      (!filters.stage || filters.stage === 'all' || (filters.stage === 'active' ? !archived(ticket) : filters.stage === 'archive' ? archived(ticket) : stage(ticket) === filters.stage)) &&
      (!search || `${ticket.number} ${ticket.title}`.toLowerCase().includes(search)))
      .sort((a,b) => rank(a) - rank(b) || a.number - b.number || a.repo.localeCompare(b.repo));
  }
  function summarize(tickets) {
    const unassessed = tickets.filter(t => !t.category || /unassessed|unknown|needs assessment/i.test(t.category)).length;
    return {tickets:tickets.length,assessed:tickets.length-unassessed,unassessed,
      openPRTickets:tickets.filter(t => (t.prs || []).some(isOpen)).length,
      mergedPRs:new Set(tickets.flatMap(t => (t.prs || []).filter(isMerged).map(p => `${t.repo}#${p.number}`))).size,
      decisions:tickets.filter(t => /decision|clarification/i.test(t.category || '') && openActions(t).length).length};
  }
  function reviewQueue(tickets, judgments = [], now = Date.now()) {
    const recommendations = new Map(judgments.map(r => [r.pr, r]));
    const unique = new Map();
    for (const ticket of tickets) for (const pr of ticket.prs || []) {
      if (isOpen(pr) && !unique.has(pr.number)) unique.set(pr.number, { pr, ticket });
    }
    const queue = { ready: [], blocked: [], unranked: [], excluded: [] };
    for (const entry of unique.values()) {
      const r = recommendations.get(entry.pr.number);
      entry.judgment = r;
      if (!r || r.head !== entry.pr.head || !Number.isFinite(Date.parse(r.assessedAt)) || now - Date.parse(r.assessedAt) > 7 * 86400000) {
        entry.blocker = r ? 'Reassess priority: the PR changed or its judgment is over seven days old.' : 'Not yet prioritized.';
        queue.unranked.push(entry); continue;
      }
      if (r?.excludedReason) { entry.blocker = r.excludedReason; queue.excluded.push(entry); continue; }
      entry.blocker = [r.blockedReason, entry.pr.ci !== 'success' ? `CI ${entry.pr.ci || 'unknown'}` : '', entry.pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : ''].filter(Boolean).join(' · ');
      queue[entry.blocker ? 'blocked' : 'ready'].push(entry);
    }
    for (const rows of Object.values(queue)) rows.sort((a,b) => (a.judgment?.rank ?? Infinity) - (b.judgment?.rank ?? Infinity) || a.pr.number - b.pr.number);
    return queue;
  }
  function safeGithubUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && /^\/[^/]+\/[^/]+\/(issues|pull)\/\d+(?:\/[^?#]*)?$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {stage,filterTickets,summarize,safeGithubUrl,reviewQueue};
  if (typeof document === 'undefined') return;
  function boot() {
    const root = document.getElementById('ticket-work');
    if (!root) return;
    const el = (tag,text,className) => {
      const node = document.createElement(tag);
      if (text != null) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    const link = (text,url) => {
      const safe = safeGithubUrl(url);
      if (!safe) return el('span',text);
      const node = el('a',text); node.href = safe; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
    };
    const date = value => {
      const parsed = new Date(value);
      return value && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).replace(/\s?(AM|PM)/g, (_, period) => period.toLowerCase()) : 'Unknown';
    };
    const heading = el('div',null,'tw-heading');
    const title = el('h2','GitHub ticket work');
    const refresh = el('button','Refresh GitHub','secondary'); refresh.type = 'button';
    heading.append(title,refresh);
    const health = el('p',null,'tw-health'); health.setAttribute('role','status');
    const priorityPanel = el('details',null,'tw-priority'); priorityPanel.open = true; priorityPanel.setAttribute('aria-label','Review first');
    priorityPanel.append(el('summary','Review first'));
    const filters = el('div',null,'tw-filters');
    const controls = {};
    function control(name,label,options) {
      const wrapper = el('label',label);
      const node = el('select'); node.id = `tw-${name}`;
      for (const [value,text] of options) { const option = el('option',text); option.value = value; node.append(option); }
      wrapper.append(node); filters.append(wrapper); controls[name] = node;
      node.addEventListener('change',() => { showAll = false; render(); });
      return node;
    }
    control('project','Sub-project',[['needs-triage','Needs Triage'],['backlog','Backlog'],['needs-refinement','Needs Refinement'],['','All sub-projects']]);
    control('category','Category',[['','All categories']]);
    control('owner','Action owner',[['','All owners']]);
    control('stage','PR stage',[['active','Next actions'],['all','All records'],['archive','Merged / closed history'],...['No PR','Draft PR','Open PR','Merged PR','Closed PR','Closed issue'].map(s => [s,s])]);
    const searchLabel = el('label','Search tickets');
    controls.search = el('input'); controls.search.type = 'search'; controls.search.placeholder = 'Issue number or title'; controls.search.id = 'tw-search';
    controls.search.addEventListener('input',() => { showAll = false; render(); }); searchLabel.append(controls.search); filters.append(searchLabel);
    const summary = el('p',null,'tw-summary');
    const count = el('p',null,'tw-count'); count.setAttribute('role','status');
    const list = el('div',null,'tw-list');
    const more = el('button','Show all records','secondary'); more.type = 'button';
    more.addEventListener('click',() => { showAll = !showAll; render(); });
    const note = el('p','Merged PRs do not confirm production deployment or full issue resolution.','tw-note');
    root.append(heading,health,priorityPanel,el('h3','All ticket next actions'),filters,summary,count,list,more,note);
    let data = null, showAll = false, fetching = false, lastRecords = '', pendingRender = false;
    const expanded = new Set();
    let priorityKey = '';
    function renderPriorities(tickets) {
      const queue = reviewQueue(tickets, data?.priorities || []);
      const key = JSON.stringify([queue,data?.priorityError,data?.stale,controls.project.value]);
      if (priorityKey === key || priorityPanel.contains(document.activeElement)) return;
      priorityKey = key;
      const openDetails = [...priorityPanel.querySelectorAll('details')].map(d => d.open);
      const title = el('summary','Review first');
      const description = el('p','Best value to move forward now: customer impact, urgency, scope and remaining work. Judgment-based; not the board priority score. Drafts still need verification.','tw-meta');
      const status = el('p',data?.priorityError || (data?.stale ? 'GitHub status is stale. Refresh before acting.' : 'Live CI and requested changes move blocked PRs out of the first five.'),'tw-meta');
      function cards(rows, numbered = false) {
        const out = el(numbered ? 'ol' : 'ul',null,'tw-review-list');
        for (const {pr,judgment,blocker} of rows) {
          const item = el('li');
          item.append(link(`#${pr.number} ${pr.title}`,pr.url));
          if (judgment) item.append(el('p',judgment.reason,'tw-review-why'));
          item.append(el('p',blocker || `Next: ${judgment?.nextAction || 'Assess the PR.'}`,'tw-action'));
          if (blocker && judgment) item.append(el('p',`Next: ${judgment.nextAction}`,'tw-meta'));
          const reviewLabel = { APPROVED: 'Human review approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Human review needed', UNKNOWN: 'Human review unverified' }[pr.review] || 'Human review unverified';
          const ciLabel = { success: 'passed', failure: 'failed', pending: 'pending' }[pr.ci] || 'unknown';
          item.append(el('p',`${pr.isDraft ? 'Draft' : 'Open'} · CI ${ciLabel} · ${reviewLabel}${judgment ? ` · Judged ${date(judgment.assessedAt)}` : ''}`,'tw-meta'));
          out.append(item);
        }
        return out;
      }
      const waiting = el('details'); waiting.open = openDetails[0] || false;
      waiting.append(el('summary',`Important but blocked (${queue.blocked.length})`),cards(queue.blocked));
      const other = el('details'); other.open = openDetails[1] || false;
      const rest = [...queue.ready.slice(5),...queue.unranked,...queue.excluded];
      other.append(el('summary',`Other open PRs / needs reassessment (${rest.length})`),cards(rest));
      priorityPanel.replaceChildren(title,description,status,queue.ready.length ? cards(queue.ready.slice(0,5),true) : el('p','No current, unblocked recommendations in this sub-project.'),waiting,other);
    }

    function updateOptions(name,values,label) {
      const node = controls[name]; const selected = node.value;
      const options = ['',...new Set(values)].sort((a,b) => a.localeCompare(b));
      if (JSON.stringify([...node.options].map(o => o.value)) === JSON.stringify(options)) return;
      node.replaceChildren(...options.map(value => { const option = el('option',value || label); option.value = value; return option; }));
      node.value = options.includes(selected) ? selected : '';
    }
    function render() {
      const snapshot = data?.snapshot;
      refresh.disabled = !!data?.health?.running;
      refresh.textContent = refresh.disabled ? 'Refreshing…' : 'Refresh GitHub';
      health.classList.toggle('tw-warning',!!data?.stale || !!data?.health?.error || !snapshot);
      health.textContent = [snapshot ? `Last successful refresh: ${date(snapshot.refreshedAt)}.` : 'Unavailable — no successful snapshot.',data?.stale ? 'Data needs a successful refresh.' : '',data?.health?.error ? `Refresh failed: ${data.health.error}` : '',data?.health?.running ? 'Refresh in progress.' : '',data?.health?.lastAttemptAt ? `Last attempt: ${date(data.health.lastAttemptAt)}.` : ''].filter(Boolean).join(' ');
      if (!snapshot) { priorityPanel.replaceChildren(el('summary','Review first'),el('p','PR recommendations unavailable until ticket status loads.')); priorityKey = ''; summary.textContent = 'Ticket counts unavailable.'; count.textContent = ''; list.replaceChildren(); more.hidden = true; return; }
      updateOptions('category',snapshot.tickets.map(t => t.category || 'Unknown'),'All categories');
      updateOptions('owner',snapshot.tickets.map(t => t.owner || 'Owner needed'),'All owners');
      const selected = Object.fromEntries(Object.entries(controls).map(([key,node]) => [key,node.value]));
      const project = snapshot.projects.find(p => p.id === selected.project);
      const projectTickets = snapshot.tickets.filter(t => !selected.project || t.projects.includes(selected.project));
      renderPriorities(projectTickets);
      const totals = summarize(projectTickets);
      summary.textContent = project && !project.assessed ? `${project.name}: Not assessed. Assessment and implementation have not been run.` : `${totals.tickets} tickets · ${totals.assessed} assessed · ${totals.unassessed} unassessed · ${totals.openPRTickets} tickets with open PRs · ${totals.mergedPRs} merged PRs · ${totals.decisions} awaiting decisions`;
      const matches = filterTickets(snapshot.tickets,selected);
      const visible = showAll ? matches : matches.slice(0,5);
      count.textContent = matches.length ? `Showing ${visible.length} of ${matches.length} matching tickets` : project && !project.assessed ? 'Not assessed — no assessment results to show.' : 'No tickets match these filters.';
      more.hidden = matches.length <= 5; more.textContent = showAll ? 'Show first five' : `Show all ${matches.length} matching tickets`;
      const recordKey = JSON.stringify(visible);
      if (recordKey === lastRecords) return;
      if (list.contains(document.activeElement)) { pendingRender = true; return; }
      lastRecords = recordKey; pendingRender = false;
      list.replaceChildren(...visible.map(ticket => {
        const key = `${ticket.repo}#${ticket.number}`;
        const row = el('article',null,'tw-ticket');
        const heading = el('h3'); heading.append(link(`#${ticket.number} ${ticket.title}`,ticket.url));
        const meta = el('p',`${ticket.category || 'Needs assessment'} · ${stage(ticket)}`,'tw-meta');
        const action = el('p',actionText(ticket),'tw-action');
        const owner = el('p',`Action owner: ${ticket.owner || openActions(ticket)[0]?.owner || 'Owner needed'}`,'tw-meta');
        const blockers = openActions(ticket).filter(item => (item.blocking || /block|decision|clarif|depend/i.test(item.text)) && item.text !== actionText(ticket));
        const blocker = el('p',blockers.length ? `Also outstanding: ${blockers.map(item => item.text).join(' · ')}` : '', 'tw-meta');
        blocker.hidden = !blockers.length;
        const prs = el('div',null,'tw-prs');
        for (const pr of ticket.prs || []) prs.append(link(`PR #${pr.number} · ${pr.state}${pr.isDraft ? ' · Draft' : ''}`,pr.url));
        const freshness = el('p',`Observed ${date(ticket.observedAt)} · Assessment ${ticket.assessmentDate || 'Not assessed'}`,'tw-meta');
        const details = el('details'); details.open = expanded.has(key);
        const outstanding = openActions(ticket);
        details.append(el('summary',`Assessment, evidence and ${outstanding.length} outstanding action${outstanding.length === 1 ? '' : 's'}`));
        details.addEventListener('toggle',() => details.open ? expanded.add(key) : expanded.delete(key));
        details.append(el('p',ticket.reason || 'No assessment recorded.'),el('p',`GitHub issue: ${ticket.state || 'Unknown'} · Board status: ${ticket.boardStatus || 'Unknown'}`));
        for (const pr of ticket.prs || []) details.append(el('p',`PR #${pr.number}: CI ${pr.ci || 'Unknown'} · Review ${pr.review || 'Unknown'} · Requested reviewers: ${(pr.reviewers || []).join(', ') || 'Unknown'} · Head ${pr.head || 'Unknown'}`));
        const actions = el('ul');
        for (const item of ticket.actions || []) {
          const li = el('li',`${item.text} — ${item.owner || 'Owner needed'} · ${item.state || 'Unknown'} · Recorded ${date(item.recordedAt)}${item.head ? ` · Head ${item.head}` : ''}`);
          if (item.source) { li.append(document.createTextNode(' · '),link('Evidence',item.source)); if (!safeGithubUrl(item.source)) li.append(document.createTextNode(`: ${item.source}`)); }
          actions.append(li);
        }
        details.append(actions); row.append(heading,meta,action,owner,blocker,prs,freshness,details); return row;
      }));
    }
    list.addEventListener('focusout',() => setTimeout(() => { if (pendingRender && !list.contains(document.activeElement)) render(); },0));
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch('/api/ticket-work',{cache:'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json(); render();
      } catch {
        health.textContent = 'Ticket service unavailable. Displaying the last received records, if any.';
        health.classList.add('tw-warning');
      } finally { fetching = false; }
    }
    refresh.addEventListener('click',async () => {
      refresh.disabled = true;
      try {
        const response = await fetch('/api/ticket-work/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await poll();
      } catch { health.textContent = 'Could not start refresh. Try again.'; health.classList.add('tw-warning'); }
      finally { refresh.disabled = !!data?.health?.running; }
    });
    health.textContent = 'Loading cached ticket work…';
    poll(); const timer = setInterval(poll,10000);
    window.addEventListener('pagehide',() => clearInterval(timer),{once:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
}());
