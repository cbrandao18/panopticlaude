// Background workers outside Orca: Mac LaunchAgents (com.christie.*) and VM systemd user timers.
// Each becomes a row in the Now page's Automations table; a failed or missed one shows as Down, which roost-medic fixes.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runOnHost } = require('./security-api');

const exec = promisify(execFile);
const AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
// Roost itself and roost-medic (which has its own row) are left out.
const SKIP = new Set(['panopticlaude-dashboard', 'roost-medic']);
const OVERDUE_MS = 30 * 60000;
const CONFLICT = '.local/state/agent-sync/conflict';

const every = (sec) => (sec >= 3600 ? `every ${+(sec / 3600).toFixed(1)} h` : `every ${Math.round(sec / 60)} min`);
const row = (host, name, kind, fields) => ({
  key: `${host}|worker:${name}`, id: name, host, name, enabled: true, kind, status: 'completed', error: '',
  lastRunAt: null, nextRunAt: null, schedule: '', ...fields
});

// A StartCalendarInterval like { Hour: 3, Minute: 0 } as "daily at 3:00am".
function calendarText(cal) {
  if (!cal || cal.Hour == null) return 'on a calendar schedule';
  const h = cal.Hour % 12 || 12;
  const day = cal.Weekday != null ? ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][cal.Weekday % 7] : 'daily';
  return `${day} at ${h}:${String(cal.Minute || 0).padStart(2, '0')}${cal.Hour < 12 ? 'am' : 'pm'}`;
}

// `launchctl print` output for one LaunchAgent (null when it isn't loaded); `calendar` is its StartCalendarInterval.
function launchdRow(name, text, conflict = '', calendar = null) {
  const kind = 'LaunchAgent';
  if (text == null) return row('mac', name, kind, { status: 'failed', error: `com.christie.${name} is not loaded in launchd` });
  const field = (k) => new RegExp(`^\\t${k} = (.+)$`, 'm').exec(text)?.[1];
  const interval = +(/^(\d+) seconds/.exec(field('run interval') || '')?.[1] || 0);
  const exit = field('last exit code');
  const timed = interval || /com\.apple\.launchd\.calendarinterval/.test(text);
  const fields = { schedule: interval ? every(interval) : timed ? calendarText(calendar) : 'always on' };
  if (!timed && field('state') !== 'running') return row('mac', name, kind, { ...fields, status: 'failed', error: `com.christie.${name} should always run but is ${field('state') || 'stopped'}` });
  if (exit && /^-?\d+$/.test(exit) && exit !== '0') return row('mac', name, kind, { ...fields, status: 'failed', error: `com.christie.${name}: last run exited with code ${exit}` });
  if (conflict) return row('mac', name, kind, { ...fields, status: 'failed', error: `sync stopped on a conflict: ${conflict}` });
  return row('mac', name, kind, { ...fields, status: field('state') === 'running' ? 'running' : 'completed' });
}

async function readMac({ run = exec, dir = AGENTS_DIR, home = os.homedir() } = {}) {
  const names = (await fs.readdir(dir)).map((f) => /^com\.christie\.(.+)\.plist$/.exec(f)?.[1]).filter((n) => n && !SKIP.has(n));
  const conflict = await fs.readFile(path.join(home, CONFLICT), 'utf8').then((t) => t.trim().slice(0, 200) || 'see ~/' + CONFLICT, () => '');
  return Promise.all(names.sort().map(async (n) => {
    const text = await run('launchctl', ['print', `gui/${process.getuid()}/com.christie.${n}`]).then((r) => r.stdout, () => null);
    const calendar = text && /calendarinterval/.test(text)
      ? await run('plutil', ['-extract', 'StartCalendarInterval', 'json', '-o', '-', path.join(dir, `com.christie.${n}.plist`)]).then((r) => JSON.parse(r.stdout), () => null)
      : null;
    return launchdRow(n, text, n === 'agent-sync' ? conflict : '', Array.isArray(calendar) ? calendar[0] : calendar);
  }));
}

const VM_SCRIPT = `export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/.config/systemd/user || exit 1
systemctl --user list-timers --all --output=json
echo @@SHOW
systemctl --user show $(ls *.timer | sed 's/\\.timer$/.service/') -p Id,Result,ExecMainStatus,ActiveState
echo @@CONFLICT
head -c 200 ~/${CONFLICT} 2>/dev/null || true`;

// The VM script's output: timers as JSON, then each service's result, then any agent-sync conflict.
function parseVm(text, now = Date.now()) {
  const [timersPart, rest = ''] = text.split('\n@@SHOW\n');
  const [showPart, conflict = ''] = rest.split('@@CONFLICT\n');
  const services = new Map();
  for (const block of showPart.trim().split(/\n\s*\n/)) {
    const f = Object.fromEntries(block.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    if (f.Id) services.set(f.Id, f);
  }
  return JSON.parse(timersPart).filter((t) => services.has(t.activates)).map((t) => {
    const name = t.activates.replace(/\.service$/, '');
    const s = services.get(t.activates);
    const lastRunAt = t.last ? Math.round(t.last / 1000) : null;
    const nextRunAt = t.next ? Math.round(t.next / 1000) : null;
    const fields = { lastRunAt, nextRunAt, schedule: 'systemd timer' };
    if (s.ActiveState === 'activating' || s.ActiveState === 'active') return row('vm', name, 'systemd timer', { ...fields, status: 'running' });
    if (s.Result && s.Result !== 'success') return row('vm', name, 'systemd timer', { ...fields, status: 'failed', error: `${name}.service: ${s.Result}, exit ${s.ExecMainStatus}` });
    if (nextRunAt && nextRunAt < now - OVERDUE_MS) return row('vm', name, 'systemd timer', { ...fields, status: 'overdue' });
    if (name === 'agent-sync' && conflict.trim()) return row('vm', name, 'systemd timer', { ...fields, status: 'failed', error: `sync stopped on a conflict: ${conflict.trim()}` });
    return row('vm', name, 'systemd timer', fields);
  });
}

async function readWorkers({ run = exec, host = runOnHost } = {}) {
  const [mac, vm] = await Promise.all([
    readMac({ run }).catch((e) => [row('mac', 'Mac background automations', 'LaunchAgent', { status: 'unreadable', error: e.message })]),
    host(VM_SCRIPT, run).then((t) => parseVm(t)).catch((e) => [row('vm', 'VM background automations', 'systemd timer', { status: 'unreadable', error: String(e.message).slice(0, 300) })])
  ]);
  return [...mac, ...vm];
}

module.exports = { launchdRow, parseVm, readMac, readWorkers, VM_SCRIPT };
