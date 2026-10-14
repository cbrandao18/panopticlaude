// Local monitor for Orca automations and launchd jobs.
// User-selected drafts can be posted through the ticket-automation GitHub App.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const lib = require('../lib');
const { createPoster, receipt, digest, draftKey } = require('./posting');

const exec = promisify(execFile);
const expand = (value) => value?.replace(/^~(?=\/|$)/, os.homedir());
async function readOrca(args, run = exec) {
  const { stdout } = await run(
    process.env.ORCA_CLI_COMMAND || '/usr/local/bin/orca',
    ['automations', ...args, '--json'],
    {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  const response = JSON.parse(stdout);
  if (!response.ok) {
    throw new Error('Orca could not return automation data.');
  }
  return response.result;
}

// Why a held draft wasn't posted. The weekly sweep-tuning automation reads these keys.
const SKIP_REASONS = {
  'no-scope-change': 'Doesn’t change what gets built',
  'wrong-or-overstated': 'Finding is wrong or overstated',
  'already-known': 'Team already knows or decided this',
  'too-long-or-technical': 'Too long or too technical for this ticket',
  'bad-timing': 'Bad timing: ticket closed, in progress, or owned elsewhere',
  'handled-myself': 'I’ll handle it myself (Slack, ticket edit, or my own comment)'
};
const feedbackPath = (job, draft) => path.join(job.inbox, '.monitor-feedback', `${draftKey(job, draft)}.json`);
function readFeedback(job, draft) {
  try {
    return JSON.parse(fs.readFileSync(feedbackPath(job, draft), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function latestOrcaRun(runs) {
  return [...runs].sort((a, b) => (b.createdAt || b.scheduledFor) - (a.createdAt || a.scheduledFor))[0] || null;
}
const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css']
};

function loadJobs(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const jobs = Array.isArray(config) ? config : config.crons;
  if (!Array.isArray(jobs) || !jobs.length) {
    throw new Error('Add at least one job to the crons array in your monitor config.');
  }
  const labels = new Set();
  return jobs.map((job) => {
    if (typeof job.label !== 'string' || !/^[\w.-]+$/.test(job.label) || labels.has(job.label)) {
      throw new Error('Each job needs a unique label.');
    }
    labels.add(job.label);
    if (!job.log || typeof job.log !== 'string') {
      throw new Error(`${job.label} needs a log path.`);
    }
    return { ...job, log: expand(job.log), inbox: expand(job.inbox) };
  });
}

function inboxFiles(dir) {
  if (!dir) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((file) => file.isFile() && !file.name.startsWith('.'))
    .map((file) => ({ name: file.name, mtime: fs.statSync(path.join(dir, file.name)).mtimeMs }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function jobStatus(job, { run = exec, readSeen = lib.loadInboxSeen } = {}) {
  const warnings = [];
  let schedule = null;
  let launch = null;
  let lastLogAt = null;
  let files = [];
  let automation = null;
  let latestRun = null;
  if (job.automationId) {
    try {
      const [details, history] = await Promise.all([
        readOrca(['show', job.automationId], run),
        readOrca(['runs', '--id', job.automationId], run)
      ]);
      automation = details.automation;
      latestRun = latestOrcaRun(history.runs);
      const hour = automation.rrule.match(/(?:^|;)BYHOUR=(\d+)(?:;|$)/)?.[1];
      const minute = automation.rrule.match(/(?:^|;)BYMINUTE=(\d+)(?:;|$)/)?.[1];
      const day = automation.rrule.match(/(?:^|;)BYDAY=(MO|TU|WE|TH|FR|SA|SU)(?:;|$)/)?.[1];
      const time = hour != null && minute != null ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : null;
      schedule =
        automation.rrule.startsWith('FREQ=DAILY;') && time
          ? `Daily at ${time} · ${automation.timezone}`
          : automation.rrule.startsWith('FREQ=WEEKLY;') && time && day
            ? `${{ MO: 'Mon', TU: 'Tues', WE: 'Wednes', TH: 'Thurs', FR: 'Fri', SA: 'Satur', SU: 'Sun' }[day]}days at ${time} · ${automation.timezone}`
            : automation.rrule;
      if (latestRun?.error) {
        warnings.push(latestRun.error);
      }
    } catch {
      automation = null;
      latestRun = null;
      warnings.push('Couldn’t read Orca status. Check that the Orca host is running.');
    }
  } else {
    try {
      const { stdout } = await run(
        'plutil',
        ['-convert', 'json', '-o', '-', path.join(os.homedir(), 'Library/LaunchAgents', `${job.label}.plist`)],
        { timeout: 4000 }
      );
      schedule = lib.scheduleFromPlist(JSON.parse(stdout));
      if (!schedule) {
        warnings.push('Schedule is unavailable.');
      }
    } catch {
      warnings.push('Couldn’t read the launchd schedule.');
    }
    try {
      const { stdout } = await run('launchctl', ['print', `gui/${process.getuid()}/${job.label}`], { timeout: 4000 });
      launch = stdout;
    } catch {
      warnings.push('Job isn’t loaded, or launchd status is unavailable.');
    }
  }
  try {
    lastLogAt = fs.statSync(job.log).mtimeMs;
  } catch {
    warnings.push('Run log is missing or unreadable.');
  }
  try {
    files = inboxFiles(job.inbox);
  } catch {
    warnings.push('Draft inbox is missing or unreadable.');
  }
  const seen = readSeen()[job.label] || {};
  files = files.map((file) => ({ ...file, unread: seen[file.name] !== file.mtime }));
  const exit = lib.lastExitCodeFromLaunchctl(launch);
  const running = /^\s*state = running\s*$/m.test(launch || '') || /^\s*pid = \d+/m.test(launch || '');
  const overdue = !job.automationId && !running && lib.cronOverdue(schedule, lastLogAt);
  let status = running
    ? 'running'
    : launch == null
      ? 'unknown'
      : exit && !['0', 'never-exited'].includes(exit)
        ? 'failed'
        : overdue
          ? 'overdue'
          : warnings.length || exit == null
            ? 'unknown'
            : exit === 'never-exited'
              ? 'waiting'
              : 'ok';
  if (job.automationId) {
    status = 'unknown';
    if (automation) {
      if (['dispatching', 'dispatched', 'running'].includes(latestRun?.status)) {
        status = 'running';
      } else if (!automation.enabled) {
        status = 'paused';
      } else if (!latestRun) {
        status = 'waiting';
      } else if (['completed', 'failed', 'skipped', 'cancelled'].includes(latestRun.status)) {
        status = latestRun.status;
      }
    }
  }
  return {
    label: job.label,
    name: job.name || job.label.replace(/^com\.[^.]+\./, ''),
    schedule,
    source: job.automationId ? 'orca' : 'launchd',
    nextRunAt: job.automationId ? (automation?.enabled ? automation.nextRunAt : null) : lib.nextRun(schedule),
    lastRunAt: latestRun?.startedAt || latestRun?.createdAt || null,
    lastLogAt,
    exit,
    status,
    warnings,
    hasInbox: Boolean(job.inbox),
    files,
    unread: files.filter((file) => file.unread).length,
    latestDraft: lib.latestDraftFile(files.map((file) => file.name)),
    repo: /^[\w.-]+\/[\w.-]+$/.test(job.repo || '') ? job.repo : null
  };
}

// GitHub's renderer returns sanitized HTML that matches how the posted comment will look.
async function renderGithubMarkdown(text, repo, run = exec) {
  const args = ['api', 'markdown', '-f', `text=${text}`, '-f', 'mode=gfm'];
  if (repo) {
    args.push('-f', `context=${repo}`);
  }
  const { stdout } = await run('/opt/homebrew/bin/gh', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function createMonitor({
  jobs,
  run,
  postDraft = createPoster(),
  renderMarkdown = renderGithubMarkdown,
  readSeen = lib.loadInboxSeen,
  writeSeen = lib.saveInboxSeen
}) {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // Reject DNS rebinding and cross-origin requests, including writes from other local apps.
    const hosts = [`127.0.0.1:${res.socket.localPort}`, `localhost:${res.socket.localPort}`];
    if (
      !hosts.includes(req.headers.host) ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    ) {
      return send(403, { error: 'Open the monitor from its localhost URL.' });
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        return send(200, fs.readFileSync(path.join(__dirname, file)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const rows = await Promise.all(jobs.map((job) => jobStatus(job, { run, readSeen })));
        return send(200, {
          jobs: rows,
          updatedAt: Date.now(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
      }
      const job = jobs.find((item) => item.label === url.searchParams.get('job'));
      if (!job) {
        return send(404, { error: 'Job not found.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/log') {
        const kind = url.searchParams.get('kind') || 'runs';
        if (job.automationId && ['output', 'errors'].includes(kind)) {
          const history = await readOrca(['runs', '--id', job.automationId], run);
          const latest = latestOrcaRun(history.runs);
          return send(200, {
            name: latest?.title || 'No Orca runs yet',
            text:
              kind === 'errors'
                ? latest?.error || 'No error reported by Orca.'
                : latest?.outputSnapshot?.content || 'No saved output yet. Open the run in Orca to see live progress.',
            truncated: kind === 'output' && Boolean(latest?.outputSnapshot?.truncated)
          });
        }
        const logs = {
          runs: job.log,
          output: path.join(path.dirname(job.log), 'cron.out'),
          errors: path.join(path.dirname(job.log), 'launchd.err')
        };
        const file = logs[url.searchParams.get('kind') || 'runs'];
        if (!file) {
          return send(404, { error: 'Log not found.' });
        }
        return send(200, {
          name: path.basename(file),
          text: lib.readTail(file, 65536),
          truncated: fs.statSync(file).size > 65536
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const file = inboxFiles(job.inbox).find((item) => item.name === url.searchParams.get('name'));
        if (!file) {
          return send(404, { error: 'Draft not found.' });
        }
        const filePath = path.join(job.inbox, file.name);
        if (fs.statSync(filePath).size > 1024 * 1024) {
          return send(413, { error: 'This file is too large to preview (over 1 MB).' });
        }
        const text = fs.readFileSync(filePath, 'utf8');
        const parsed = lib.parseDraftsFile(text);
        return send(200, {
          ...file,
          text,
          version: digest(text),
          ...parsed,
          drafts: await Promise.all(
            parsed.drafts.map(async (draft) => {
              const expanded = { ...draft, body: job.repo ? lib.expandRelativeLinks(draft.body, job.repo) : draft.body };
              // The raw body stays the source of truth; a failed render falls back to it in the page.
              const html = await renderMarkdown(expanded.body, job.repo).catch(() => null);
              return { ...expanded, html, posting: receipt(job, expanded), skipped: readFeedback(job, expanded) };
            })
          ),
          skipReasons: SKIP_REASONS
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/post') {
        if (req.headers['x-panopticlaude'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
          return send(403, { error: 'Post requests must come from the monitor.' });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) {
            return send(413, { error: 'Post request is too large.' });
          }
        }
        let request;
        try {
          request = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid post request.' });
        }
        if (!request || !Number.isSafeInteger(request.n) || typeof request.version !== 'string') {
          return send(400, { error: 'Choose a draft to post.' });
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(job.repo || '')) {
          return send(400, { error: 'Configure a GitHub repository for this job before posting.' });
        }
        const file = inboxFiles(job.inbox).find((item) => item.name === request.name);
        if (!file) {
          return send(404, { error: 'Draft not found.' });
        }
        const filePath = path.join(job.inbox, file.name);
        if (fs.statSync(filePath).size > 1024 * 1024) {
          return send(413, { error: 'This file is too large to post.' });
        }
        const text = fs.readFileSync(filePath, 'utf8');
        if (digest(text) !== request.version) {
          return send(409, { error: 'This draft changed. Reopen it and review the latest version.' });
        }
        const parsed = lib.parseDraftsFile(text);
        if (parsed.posted) {
          return send(409, { error: 'This file is marked as posted. Check its source notes.' });
        }
        const matches = parsed.drafts.filter((draft) => draft.n === request.n);
        if (matches.length !== 1) {
          return send(400, { error: 'This draft number is missing or duplicated in the file.' });
        }
        const draft = matches[0];
        try {
          return send(200, await postDraft(job, { ...draft, body: lib.expandRelativeLinks(draft.body, job.repo) }));
        } catch (error) {
          return send(409, { error: error.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/skip') {
        if (req.headers['x-panopticlaude'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
          return send(403, { error: 'Feedback must come from the monitor.' });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 16384) {
            return send(413, { error: 'This note is too long.' });
          }
        }
        let request;
        try {
          request = JSON.parse(body);
        } catch {
          return send(400, { error: 'Invalid feedback request.' });
        }
        const reasons = request?.reasons;
        const note = typeof request?.note === 'string' ? request.note.trim() : '';
        if (
          !Number.isSafeInteger(request?.n) ||
          typeof request.version !== 'string' ||
          !Array.isArray(reasons) ||
          reasons.some((reason) => !Object.hasOwn(SKIP_REASONS, reason)) ||
          note.length > 4000
        ) {
          return send(400, { error: 'Invalid feedback request.' });
        }
        if (!reasons.length && !note) {
          return send(400, { error: 'Pick a reason or add a note.' });
        }
        const file = inboxFiles(job.inbox).find((item) => item.name === request.name);
        if (!file) {
          return send(404, { error: 'Draft not found.' });
        }
        const text = fs.readFileSync(path.join(job.inbox, file.name), 'utf8');
        if (digest(text) !== request.version) {
          return send(409, { error: 'This draft changed. Reopen it and review the latest version.' });
        }
        const matches = lib.parseDraftsFile(text).drafts.filter((draft) => draft.n === request.n);
        if (matches.length !== 1) {
          return send(400, { error: 'This draft number is missing or duplicated in the file.' });
        }
        const draft = matches[0];
        const expanded = { ...draft, body: job.repo ? lib.expandRelativeLinks(draft.body, job.repo) : draft.body };
        const feedback = {
          issue: draft.issue,
          file: file.name,
          n: draft.n,
          title: draft.title,
          reasons: [...new Set(reasons)],
          note,
          savedAt: new Date().toISOString()
        };
        fs.mkdirSync(path.dirname(feedbackPath(job, expanded)), { recursive: true });
        fs.writeFileSync(feedbackPath(job, expanded), JSON.stringify(feedback, null, 2));
        return send(200, feedback);
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        if (req.headers['x-panopticlaude'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
          return send(403, { error: 'Review requests must come from the monitor.' });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 65536) {
            return send(413, { error: 'Too many files in this review request.' });
          }
        }
        let files;
        try {
          ({ files } = JSON.parse(body));
        } catch {
          return send(400, { error: 'Invalid review request.' });
        }
        if (!Array.isArray(files) || !files.length) {
          return send(400, { error: 'Choose a draft to mark reviewed.' });
        }
        const current = new Map(inboxFiles(job.inbox).map((file) => [file.name, file.mtime]));
        if (files.some((file) => !file || !current.has(file.name) || current.get(file.name) !== file.mtime)) {
          return send(409, { error: 'A draft changed. Refresh and review its latest version.' });
        }
        const seen = { ...(readSeen()[job.label] || {}) };
        for (const file of files) {
          seen[file.name] = file.mtime;
        }
        writeSeen(job.label, seen);
        return send(200, { reviewed: files.length });
      }
      return send(404, { error: 'Page not found.' });
    } catch (error) {
      console.error('Monitor request failed:', error.code || error.message);
      return send(error.code === 'ENOENT' ? 404 : 500, {
        error:
          error.code === 'ENOENT'
            ? 'This file is no longer available.'
            : 'Couldn’t read or save monitor data. Check the server terminal.'
      });
    }
  });
}

if (require.main === module) {
  // Reads use gh's own login; posting passes its minted bot token explicitly. A launcher-exported token
  // would override both reads, and a stale one fails them with 401.
  Reflect.deleteProperty(process.env, 'GH_TOKEN');
  Reflect.deleteProperty(process.env, 'GITHUB_TOKEN');
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  const config = args.includes('--config')
    ? option('--config')
    : path.join(os.homedir(), '.config/panopticlaude/monitor.json');
  const port = Number(args.includes('--port') ? option('--port') : process.env.CONDUCTOR_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Choose a port between 1 and 65535.');
  }
  const server = createMonitor({ jobs: loadJobs(config) });
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Panopticlaude monitor: http://localhost:${port}`));
}

module.exports = { loadJobs, inboxFiles, jobStatus, createMonitor };
