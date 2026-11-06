const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, briefData } = require('./brief-api');

test('splits the brief from state.json and reads when it was written', () => {
  const out = parse('# Midday brief · Friday, Oct 30\n\n1. Review [#1](https://x)\n@@STATE\n{"lastBriefAt": "2026-10-30T13:32:33-04:00"}\n');
  assert.equal(out.markdown, '# Midday brief · Friday, Oct 30\n\n1. Review [#1](https://x)');
  assert.equal(out.writtenAt, Date.parse('2026-10-30T17:32:33Z'));
  assert.deepEqual(parse('@@STATE\n{trunc'), { markdown: '', writtenAt: null });
});

test('renders the markdown, and skips rendering when there is no brief yet', async () => {
  const render = async (md) => `<p>${md}</p>`;
  const data = await briefData({ source: async () => 'Hi\n@@STATE\n{}', render });
  assert.equal(data.html, '<p>Hi</p>');
  const none = await briefData({ source: async () => '\n@@STATE\n', render: () => assert.fail('no render') });
  assert.equal(none.html, '');
});
