const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPoster, receipt, mintBotToken } = require('./posting');

test('bot authentication accepts installation tokens containing dots and hyphens', async () => {
  assert.equal(
    await mintBotToken(async () => ({ stdout: 'ghs_fixture.part-with-hyphen\n' }), '/fixture/mint.sh'),
    'ghs_fixture.part-with-hyphen'
  );
  await assert.rejects(
    mintBotToken(async () => ({ stdout: 'not-a-token' }), '/fixture/mint.sh'),
    /authenticate/
  );
});

function fixture(t, options = {}) {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-posting-'));
  t.after(() => fs.rmSync(inbox, { recursive: true, force: true }));
  const job = { inbox, repo: 'owner/repo' };
  const draft = { n: 1, issue: 123, body: 'Exact comment with `code` and $(text).\n' };
  const calls = [];
  const run = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (args[1] === 'view') {
      return { stdout: JSON.stringify(options.info || { state: 'OPEN', comments: [] }) };
    }
    assert.equal(opts.env.GH_TOKEN, 'ghs_fixture');
    assert.equal(fs.readFileSync(args.at(-1), 'utf8'), draft.body);
    if (options.fail) {
      throw new Error('sensitive process failure');
    }
    return { stdout: 'https://github.com/owner/repo/issues/123#issuecomment-456\n' };
  };
  const mint = options.mint || (async () => 'ghs_fixture');
  return { job, draft, calls, run, mint, post: createPoster({ run, mint }) };
}

test('posts exact body as the bot, cleans temp file, and survives restart without reposting', async (t) => {
  const f = fixture(t);
  const result = await f.post(f.job, f.draft);
  assert.equal(result.status, 'posted');
  assert.equal(fs.existsSync(f.calls[1].args.at(-1)), false);
  assert.deepEqual(receipt(f.job, f.draft), result);
  const restarted = createPoster({ run: f.run, mint: f.mint });
  assert.deepEqual(await restarted(f.job, f.draft), result);
  assert.equal(f.calls.length, 2);
});

test('closed issues and existing assessment comments never trigger a write', async (t) => {
  const closed = fixture(t, { info: { state: 'CLOSED', comments: [] } });
  await assert.rejects(closed.post(closed.job, closed.draft), /closed/);
  assert.equal(closed.calls.length, 1);
  const existing = fixture(t, {
    info: {
      state: 'OPEN',
      comments: [{ body: 'Automated assumption check', url: 'https://github.com/owner/repo/issues/123#issuecomment-9' }]
    }
  });
  assert.equal((await existing.post(existing.job, existing.draft)).status, 'posted');
  assert.equal(existing.calls.length, 1);
});

test('concurrent clicks submit once', async (t) => {
  let release;
  const f = fixture(t, {
    mint: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  const first = f.post(f.job, f.draft);
  await assert.rejects(f.post(f.job, f.draft), /in progress/);
  release('ghs_fixture');
  await first;
  assert.equal(f.calls.filter((call) => call.args[1] === 'comment').length, 1);
});

test('uncertain failures block reposting and can reconcile an accepted comment', async (t) => {
  const f = fixture(t, { fail: true });
  await assert.rejects(f.post(f.job, f.draft), /Couldn’t confirm/);
  assert.equal(receipt(f.job, f.draft).status, 'pending');
  await assert.rejects(f.post(f.job, f.draft), /unknown outcome/);
  assert.equal(f.calls.filter((call) => call.args[1] === 'comment').length, 1);
  const recovered = createPoster({
    run: async () => ({
      stdout: JSON.stringify({
        state: 'OPEN',
        comments: [{ body: f.draft.body, url: 'https://github.com/owner/repo/issues/123#issuecomment-456' }]
      })
    })
  });
  assert.equal((await recovered(f.job, f.draft)).status, 'posted');
});

test('authentication failure never posts or reserves the draft', async (t) => {
  const f = fixture(t, {
    mint: async () => {
      throw new Error('Bot auth unavailable');
    }
  });
  await assert.rejects(f.post(f.job, f.draft), /auth unavailable/);
  assert.equal(f.calls.length, 1);
  assert.equal(receipt(f.job, f.draft), null);
});
