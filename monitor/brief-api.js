// The daily brief at the top of the dashboard: the VM's daily-brief/brief.md (the same text the Slack DM is
// rendered from) and when it was written, rendered as GitHub markdown. Read-only.
const { runOnHost } = require('./security-api');

const SCRIPT = [
  'cd ~/orca/projects/daily-brief || exit 1',
  'cat brief.md 2>/dev/null',
  "echo; echo '@@STATE'",
  'cat state.json 2>/dev/null',
  'true'
].join('\n');

function parse(text) {
  const [markdown, statePart = ''] = `\n${text}`.split('\n@@STATE\n');
  let state = {};
  try {
    state = statePart.trim() ? JSON.parse(statePart) : {};
  } catch {
    state = {};
  }
  return { markdown: markdown.trim(), writtenAt: Date.parse(state.lastBriefAt) || null };
}

async function briefData({ source = () => runOnHost(SCRIPT), render }) {
  const { markdown, writtenAt } = parse(await source());
  if (!markdown) return { refreshedAt: Date.now(), writtenAt, html: '' };
  return { refreshedAt: Date.now(), writtenAt, html: await render(markdown, 'gobranch/branch') };
}

function createBriefReader(options, ttl = 60000) {
  let cached = null;
  let pending = null;
  return () => {
    if (cached && Date.now() - cached.refreshedAt < ttl) return Promise.resolve(cached);
    pending ||= briefData(options)
      .then((data) => (cached = data))
      .catch((e) => ({ refreshedAt: Date.now(), error: `Couldn't read the daily brief: ${String(e.message).slice(0, 200)}` }))
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { parse, briefData, createBriefReader };
