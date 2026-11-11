// Browser regression check. Uses an installed Playwright; no live services or writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createMonitor } = require('../monitor/server');

async function main() {
  const data = {
    refreshedAt: Date.now(), down: [], vendors: [], unwatched: [], waitingPrs: [],
    ready: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `Example change ${i + 1}`, url: `https://example.com/pull/${i + 1}` })),
    blocked: { agents: [], reviews: [], ease: [], drafts: [] }, releases: [], errors: [],
    slots: null, slotsError: 'Fixture queue unavailable',
    automations: [{ key: 'example', name: 'Example automation', status: 'completed', host: 'vm' }]
  };
  const server = createMonitor({ jobs: [], readNow: async () => data,
    readBrief: async () => ({ html: '<p>Example daily brief.</p>', writtenAt: Date.now() }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Other pages only need their shared navigation checked here; keep their readers offline.
    await page.route('**/api/**', route => ['/api/now', '/api/brief'].includes(new URL(route.request().url()).pathname)
      ? route.continue() : route.fulfill({ status: 503, json: { error: 'Offline fixture' } }));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.locator('.sidebar').waitFor({ timeout: 5000 });
    await page.locator('.autos tbody tr').waitFor();
    assert.equal(await page.locator('.tier:has(#ship-title) .rows li').count(), 5);
    const views = [['needs-you', 'Needs you', 'Blocked on you'], ['ready', 'Ready to ship', 'Ready to ship'],
      ['health', 'Health', 'Down'], ['automations', 'Automations', 'Automations'],
      ['queue', 'Agent queue', 'Agent slots'], ['projects', 'Projects', 'Project watch'], ['brief', 'Daily brief', 'Daily brief']];
    for (const [hash, title, section] of views) {
      await page.locator(`.sidebar a[href="/#${hash}"]`).click();
      await page.waitForFunction(title => document.querySelector('.page-heading h1')?.textContent === title, title);
      assert.equal(await page.locator('.sidebar [aria-current="page"]').count(), 1);
      assert.equal(await page.locator('.tier').count(), 1, `${title} has only its own content`);
      assert.match(await page.locator('.tier h2').first().textContent(), new RegExp(section));
      if (hash === 'ready') {
        assert.equal(await page.locator('.rows li').count(), 7, 'Focused lists start expanded');
        await page.getByRole('button', { name: 'Show fewer' }).click();
        assert.equal(await page.locator('.rows li').count(), 5);
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
    for (const route of ['/#automations', '/map', '/work']) {
      await page.goto(base + route);
      await page.locator('.sidebar [aria-current="page"]').waitFor();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} fits at ${width}px`);
      }
    }
    // Enough synthetic log content to exercise an existing Work anchor under the mobile header.
    await page.locator('#jobs').evaluate(node => { node.innerHTML = '<h2>Example jobs</h2>' + '<p>Example job</p>'.repeat(40); });
    await page.evaluate(() => { location.hash = 'jobs'; });
    await page.waitForFunction(() => location.hash === '#jobs');
    const jobs = await page.locator('#jobs').boundingBox();
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
