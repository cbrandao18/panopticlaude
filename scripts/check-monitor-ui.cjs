// Browser regression check. Uses an installed Playwright; no live services or writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createMonitor } = require('../monitor/server');

async function main() {
  const data = {
    refreshedAt: Date.now(), down: [], vendors: [], unwatched: [], waitingPrs: [], reviewPrs: [{ number: 90, title: 'Example draft', url: 'https://example.com/pull/90' }],
    ready: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `Example change ${i + 1}`, url: `https://example.com/pull/${i + 1}` })),
    blocked: { agents: [], reviews: [], ease: [], drafts: [] }, releases: [], errors: [],
    attention: {
      waiting: { agents: [{ key: 'request', name: 'Example workspace', ask: 'Approve the example change', host: 'vm' }],
        reviews: [{ url: 'https://example.com/review', number: 99, title: 'Example review', author: 'example' }], ease: [], drafts: [] },
      blocked: [{ key: 'blocked', name: 'Example workspace', ask: 'Access expired', host: 'vm' }],
      failed: [{ key: 'failed', workspaceKey: null, name: 'Example run', ask: 'Run exited 1', url: '/work#jobs' }],
      fyi: [{ key: 'fyi', name: 'Example workspace', ask: 'Preview available' }], stalled: []
    },
    slots: null, slotsError: 'Fixture queue unavailable',
    plans: { upcoming: [{ file: 'superpowers/plans/2026-01-01-example-plan-with-a-long-file-name.md', kind: 'plan', status: 'building', title: 'Example plan', next: 'Approve the example step, which has a long description to wrap on narrow screens', updatedAt: Date.now() - 9 * 86400000, stale: true }], counts: { building: 1, done: 3 }, unlabeled: [] },
    automations: [{ key: 'example', name: 'Example automation', status: 'completed', host: 'vm' }]
  };
  const server = createMonitor({ jobs: [], readNow: async () => data,
    readEvalResults: async () => ({ suites: [{ suite: 'example', title: 'Example suite', run: '20260101T120000Z', at: Date.now(), runs: 2,
      configs: ['model-a', 'model-b'], tasks: ['task-with-a-long-example-name'],
      cells: { 'task-with-a-long-example-name': {
        'model-a': { passed: 1, total: 2, change: 'regressed', previous: { run: '20251231T120000Z', passed: 2, total: 2 },
          trials: [{ rep: 0, pass: true, secs: 5, cost: 0.01, want: { verdict: 'ready' }, got: { verdict: 'ready' } },
            { rep: 1, pass: false, secs: 6, cost: 0.01, want: { verdict: 'ready' }, got: { verdict: 'needs-a-much-longer-example-value' } }] },
        'model-b': { passed: 2, total: 2, trials: [] } } },
      totals: [{ config: 'model-a', passed: 1, total: 2, errors: 0, cost: 0.02, secs: 11, skillVersions: ['abc1234'], trend: [] },
        { config: 'model-b', passed: 2, total: 2, errors: 0, cost: 0.02, secs: 9, skillVersions: [], trend: [] }], unreadable: 0,
      taskInfo: { 'task-with-a-long-example-name': { title: 'Example task', successCriteria: 'verdict is ready', refs: ['github.com:example/repo@abc1234'], tags: [], prompt: 'Judge it.',
        ticket: { id: 'task-with-a-long-example-name', title: 'Example ticket', author_role: 'Staff', body: 'A long example body that has to wrap on a narrow phone screen without scrolling sideways.' },
        others: [{ id: 'other', title: 'Other example ticket' }] } } }] }),
    readPlanDoc: async (file) => (file === 'example.md' ? { file, title: 'Example plan', status: 'draft', next: 'Approve the example',
      markdown: '# Example plan\n\n| Source | A long column of text that has to wrap or scroll on a phone screen |\n|---|---|\n| one | two |\n\nSee [the other plan](superpowers/plans/other.md#steps).\n' } : null),
    readBrief: async () => ({ html: '<p>Example daily brief.</p>', writtenAt: Date.now() }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Other pages only need their shared navigation checked here; keep their readers offline.
    await page.route('**/api/**', route => ['/api/now', '/api/brief', '/api/plan', '/api/evals'].includes(new URL(route.request().url()).pathname)
      ? route.continue() : route.fulfill({ status: 503, json: { error: 'Offline fixture' } }));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.locator('.sidebar').waitFor({ timeout: 5000 });
    await page.locator('.autos tbody tr').waitFor();
    assert.equal(await page.locator('.tier:has(#ship-title) .rows li').count(), 5);
    const views = [['needs-you', 'Needs you', 'Work status'], ['ready', 'Ready to ship', 'Ready to ship'],
      ['health', 'Health', 'Down'], ['automations', 'Automations', 'Automations'],
      ['queue', 'Agent queue', 'Agent slots'], ['plans', 'Plans', 'Upcoming plans'], ['projects', 'Projects', 'Project watch'], ['brief', 'Daily brief', 'Daily brief']];
    for (const [hash, title, section] of views) {
      await page.locator(`.sidebar a[href="/#${hash}"]`).click();
      await page.waitForFunction(title => document.querySelector('.page-heading h1')?.textContent === title, title);
      assert.equal(await page.locator('.sidebar [aria-current="page"]').count(), 1);
      assert.equal(await page.locator('.tier').count(), hash === 'ready' ? 2 : 1, `${title} has only its own content`);
      assert.match(await page.locator('.tier h2').first().textContent(), new RegExp(section));
      if (hash === 'needs-you') {
        assert.equal(await page.getByRole('button', { name: 'Waiting on you 2', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.getByText('Example review', { exact: false }).isVisible(), false, 'Review backlog starts collapsed');
        await page.locator('summary').filter({ hasText: 'Review backlog' }).click();
        assert.equal(await page.getByText('#99 Example review', { exact: true }).isVisible(), true);
        for (const [state, label, content] of [['blocked', 'Blocked', 'Access expired'], ['failed', 'Failed', 'Run exited 1'], ['fyi', 'FYI', 'Preview available']]) {
          await page.getByRole('button', { name: `${label} 1`, exact: true }).click();
          assert.equal(await page.getByText(content, { exact: true }).isVisible(), true);
          assert.equal(await page.getByText('Approve the example change', { exact: true }).count(), 0);
          assert.equal(await page.locator(`.status-filter.${state}`).getAttribute('aria-pressed'), 'true');
        }
        await page.getByRole('button', { name: 'Waiting on you 2', exact: true }).focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.getByText('Approve the example change', { exact: true }).isVisible(), true);
      }
      if (hash === 'ready') {
        assert.equal(await page.locator('.tier:has(#ship-title) .rows li').count(), 7, 'Focused lists start expanded');
        await page.getByRole('button', { name: 'Show fewer' }).click();
        assert.equal(await page.locator('.tier:has(#ship-title) .rows li').count(), 5);
        assert.equal(await page.getByText('#90 Example draft', { exact: true }).isVisible(), true, 'Green drafts list under Ready to ship');
      }
    }
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.page-heading h1')?.textContent === 'Projects');
    await page.reload();
    assert.equal(await page.locator('.page-heading h1').textContent(), 'Projects');
    await page.goto(`${base}/#unknown`);
    assert.equal(await page.locator('.page-heading h1').textContent(), 'Overview');
    await page.locator('.sidebar a[href="/#automations"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.matches('.page-heading h1'));
    await page.goto(`${base}/plan?file=example.md`);
    await page.locator('.markdown table').waitFor();
    assert.equal(await page.locator('.markdown a').getAttribute('href'), '/plan?file=superpowers%2Fplans%2Fother.md#steps');
    assert.equal(await page.locator('.sidebar [aria-current="page"]').textContent(), 'Plans');
    await page.goto(`${base}/#evals`);
    await page.getByRole('button', { name: 'model-a on task-with-a-long-example-name: 1 of 2 passed, worse than the previous run' }).click();
    assert.equal(await page.locator('.eval-fields tr.mismatch').count(), 1, 'The failing try highlights its mismatched field');
    assert.equal(await page.locator('.sidebar [aria-current="page"]').textContent(), 'Evals');
    await page.getByRole('button', { name: 'See the task' }).click();
    assert.equal(await page.locator('.eval-ticket strong').textContent(), 'Example ticket', 'The task view shows the judged ticket');
    assert.equal(await page.locator('.eval-fields td').first().textContent(), '"ready"', 'Text values are quoted');
    for (const route of ['/#automations', '/#plans', '/#evals', '/plan?file=example.md', '/map', '/work']) {
      await page.goto(base + route);
      await page.locator('.sidebar [aria-current="page"]').waitFor();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} fits at ${width}px`);
      }
    }
    // Enough synthetic log content to exercise an existing Work anchor under the mobile header.
    await page.locator('#security').evaluate(node => { node.innerHTML = '<h2>Example section</h2>' + '<p>Example row</p>'.repeat(40); });
    await page.evaluate(() => { location.hash = 'security'; });
    await page.waitForFunction(() => location.hash === '#security');
    const jobs = await page.locator('#security').boundingBox();
    const sidebar = await page.locator('.sidebar').boundingBox();
    assert.ok(jobs.y >= sidebar.y + sidebar.height, 'Work anchors remain below the fixed mobile navigation');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: focused views, history, reload, fallback, shared navigation and responsive layout.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
