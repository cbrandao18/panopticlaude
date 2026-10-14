// Post the exact preview as ticket-automation[bot]. Durable receipts prevent retries
// from duplicating a comment, including when GitHub accepts a request that times out.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const GH = '/opt/homebrew/bin/gh';
const DUP_MARKER = 'Automated assumption check';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const draftKey = (job, draft) => digest(`${job.repo}:${draft.issue}:${draft.body}`);
const receiptPath = (job, draft) => path.join(job.inbox, '.monitor-posts', `${draftKey(job, draft)}.json`);

function receipt(job, draft) {
  try {
    return JSON.parse(fs.readFileSync(receiptPath(job, draft), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveMintScript() {
  const rel = ['skills', 'assess-assumptions', 'scripts', 'mint-bot-token.sh'];
  const root = path.join(os.homedir(), '.claude/plugins/cache/ai-agent-tools/ticket-tools');
  const candidates = [];
  if (fs.existsSync(root)) {
    for (const hash of fs.readdirSync(root)) {
      candidates.push(path.join(root, hash, ...rel));
    }
  }
  candidates.push(path.join(os.homedir(), 'branch-workshop/ai-agent-tools/plugins/ticket-tools', ...rel));
  return candidates
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function mintBotToken(run = exec, script = resolveMintScript()) {
  if (!script) {
    throw new Error('The ticket-automation token script is missing.');
  }
  try {
    const { stdout } = await run('/bin/bash', [script], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      timeout: 30000
    });
    const token = stdout.trim();
    if (!token.startsWith('ghs_') || /\s/.test(token)) {
      throw new Error('Invalid token');
    }
    return token;
  } catch {
    throw new Error('Couldn’t authenticate ticket-automation[bot]. Nothing was posted.');
  }
}

function createPoster({ run = exec, mint = () => mintBotToken(run) } = {}) {
  const active = new Set();
  return async (job, draft) => {
    const key = `${job.repo}:${draft.issue}`;
    if (active.has(key)) {
      throw new Error('This issue already has a post in progress.');
    }
    active.add(key);
    let temp;
    try {
      const previous = receipt(job, draft);
      if (previous?.status === 'posted') {
        return previous;
      }
      let info;
      try {
        const { stdout } = await run(
          GH,
          ['issue', 'view', String(draft.issue), '-R', job.repo, '--json', 'state,comments'],
          {
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024
          }
        );
        info = JSON.parse(stdout);
        if (!Array.isArray(info.comments)) {
          throw new Error('Missing comments');
        }
      } catch {
        throw new Error('Couldn’t check the issue on GitHub. Nothing was posted.');
      }
      const existing = info.comments.find(
        (comment) => comment.body?.trim() === draft.body.trim() || comment.body?.includes(DUP_MARKER)
      );
      if (existing) {
        const result = { status: 'posted', commentUrl: existing.url };
        fs.mkdirSync(path.dirname(receiptPath(job, draft)), { recursive: true });
        fs.writeFileSync(receiptPath(job, draft), JSON.stringify(result), { mode: 0o600 });
        return result;
      }
      if (info.state !== 'OPEN') {
        throw new Error('This issue is closed. Nothing was posted.');
      }
      if (previous) {
        throw new Error('A previous post has an unknown outcome. Check the issue on GitHub before trying again.');
      }
      const token = await mint();
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'panopticlaude-comment-'));
      const bodyFile = path.join(temp, 'comment.md');
      fs.writeFileSync(bodyFile, draft.body, { mode: 0o600 });
      const record = receiptPath(job, draft);
      fs.mkdirSync(path.dirname(record), { recursive: true });
      // Exclusive creation also protects two monitor processes using the same inbox.
      fs.writeFileSync(record, JSON.stringify({ status: 'pending' }), { flag: 'wx', mode: 0o600 });
      try {
        const { stdout } = await run(
          GH,
          ['issue', 'comment', String(draft.issue), '-R', job.repo, '--body-file', bodyFile],
          {
            env: { ...process.env, GH_TOKEN: token },
            timeout: 30000
          }
        );
        const commentUrl = stdout.trim();
        const prefix = `https://github.com/${job.repo}/issues/${draft.issue}#issuecomment-`;
        if (!commentUrl.startsWith(prefix) || !/^\d+$/.test(commentUrl.slice(prefix.length))) {
          throw new Error('Missing comment URL');
        }
        const result = { status: 'posted', commentUrl };
        fs.writeFileSync(record, JSON.stringify(result), { mode: 0o600 });
        return result;
      } catch {
        throw new Error('Couldn’t confirm the post. Check the issue on GitHub; a duplicate post is blocked.');
      }
    } finally {
      if (temp) {
        fs.rmSync(temp, { recursive: true, force: true });
      }
      active.delete(key);
    }
  };
}

module.exports = { createPoster, receipt, digest, draftKey, mintBotToken };
