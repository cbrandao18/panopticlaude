// Benchmark results from process-updates/evals/results/<suite>.jsonl (one line per trial, written by the
// benchmark runners): the latest run as a task-by-configuration grid, changes since each cell's previous run,
// per-configuration totals and a trend. Read-only, Mac-local files synced by agent-sync.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const EVALS = path.join(os.homedir(), 'branch-agents/projects/process-updates/evals');

function summarizeSuite(suite, trials, title = null) {
  const runs = [...new Set(trials.map((t) => t.run))].sort().reverse();
  const latest = runs[0];
  const inRun = (run) => trials.filter((t) => t.run === run);
  const now = inRun(latest);
  const configs = [...new Set(now.map((t) => t.config))];
  const tasks = [...new Set(now.map((t) => t.task))].sort();
  const tally = (list) => ({ passed: list.filter((t) => t.pass).length, total: list.length });

  const cells = {};
  for (const task of tasks) {
    cells[task] = {};
    for (const config of configs) {
      const here = now.filter((t) => t.task === task && t.config === config);
      if (!here.length) continue;
      const cell = { ...tally(here), trials: here.sort((a, b) => a.rep - b.rep) };
      // The most recent earlier run with this task and configuration.
      const prevRun = runs.slice(1).find((r) => trials.some((t) => t.run === r && t.task === task && t.config === config));
      if (prevRun) {
        const prev = tally(trials.filter((t) => t.run === prevRun && t.task === task && t.config === config));
        const delta = cell.passed / cell.total - prev.passed / prev.total;
        cell.previous = { run: prevRun, ...prev };
        cell.change = delta < 0 ? 'regressed' : delta > 0 ? 'improved' : null;
      }
      cells[task][config] = cell;
    }
  }

  const totals = configs.map((config) => {
    const list = now.filter((t) => t.config === config);
    const sum = (k) => list.reduce((n, t) => n + (Number(t[k]) || 0), 0);
    return {
      config, model: list[0].model || null, ...tally(list),
      errors: list.filter((t) => t.err).length,
      cost: Math.round(sum('cost') * 100) / 100,
      secs: sum('secs'),
      skillVersions: [...new Set(list.map((t) => t.skill_version).filter(Boolean))],
      trend: runs.slice().reverse().map((run) => ({ run, ...tally(inRun(run).filter((t) => t.config === config)) })).filter((r) => r.total)
    };
  });
  const at = now.map((t) => Date.parse(t.at)).filter(Boolean);
  return { suite, title, run: latest, at: at.length ? Math.max(...at) : null, runs: runs.length, configs, tasks, cells, totals };
}

// shortcut: reads only the shapes the benchmark task files use (top-level double-quoted strings, `>-` folded
// blocks and `- item` lists); use a real YAML parser if task files grow nested maps.
function parseTaskYaml(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\w+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest.startsWith('"')) {
      try { out[key] = JSON.parse(rest); } catch { out[key] = rest.slice(1, -1); }
    } else if (/^>-?$/.test(rest)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === '' && /^\s+\S/.test(lines[i + 2] || '')))) block.push(lines[++i].trim());
      // Folded: lines join with spaces, a blank line is a paragraph break.
      out[key] = block.join('\n').split('\n\n').map((p) => p.replace(/\n/g, ' ')).join('\n');
    } else if (rest === '') {
      const list = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) list.push(lines[++i].replace(/^\s+-\s+/, '').trim());
      out[key] = list;
    } else {
      out[key] = rest;
    }
  }
  return out;
}

// pm-judge prompts carry the ticket and the other open tickets as JSON; pull them out for a readable view.
function taskInfo(text) {
  const y = parseTaskYaml(text);
  const prompt = typeof y.prompt === 'string' ? y.prompt : '';
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const judged = /Ticket to judge:\n([\s\S]*?)\n\nOther open tickets:/.exec(prompt);
  const others = /Other open tickets:\n(\[[\s\S]*\])\s*$/.exec(prompt);
  return {
    title: y.title || null, prompt, successCriteria: y.successCriteria || null, refs: y.startingRepoRefs || [], tags: y.tags || [],
    ticket: judged ? json(judged[1]) : null,
    others: others ? (json(others[1]) || []).map((t) => ({ id: t.id, title: t.title })) : []
  };
}

async function readEvals(dir = EVALS) {
  const names = await fs.readdir(path.join(dir, 'results')).catch((e) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
  const suites = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const suite = name.replace(/\.jsonl$/, '');
    const trials = [];
    let unreadable = 0;
    for (const line of (await fs.readFile(path.join(dir, 'results', name), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        if (t.run && t.config && t.task) trials.push(t); else unreadable++;
      } catch { unreadable++; }
    }
    if (!trials.length) continue;
    const yaml = await fs.readFile(path.join(dir, 'benchmarks', suite, 'suite.yaml'), 'utf8').catch(() => '');
    const title = /^name:\s*"?(.*?)"?\s*$/m.exec(yaml)?.[1] || null;
    const summary = summarizeSuite(suite, trials, title);
    const tasks = {};
    for (const task of summary.tasks) {
      const text = await fs.readFile(path.join(dir, 'benchmarks', suite, 'tasks', `${task}.yaml`), 'utf8').catch(() => null);
      if (text) tasks[task] = taskInfo(text);
    }
    suites.push({ ...summary, taskInfo: tasks, unreadable });
  }
  return { suites, dir };
}

module.exports = { readEvals, summarizeSuite, parseTaskYaml, taskInfo };
