const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedbackData, createAssistantFeedbackReader } = require('./assistant-feedback-api');

const summary = {
  triaged: [
    { turnId: 'a', at: '2026-11-15T04:12:19Z', scores: [{ evaluator: 'Correctness', level: 'Trace', score: 1 }, { evaluator: 'GoalSuccessRate', level: 'Session', score: 0.5 }] },
    { turnId: 'b', at: '2026-11-15T01:41:36Z', scores: [{ evaluator: 'Correctness', level: 'Trace', score: 0 }] },
    { turnId: 'c', at: '2026-11-14T14:47:15Z', scores: [] }
  ],
  regression: { at: '2026-11-15T13:04:00Z', passed: true, summary: '1 of 1 passed on christie', results: [] },
  log: ['2026-11-15 8:04am down=3 up=2 fixes=1'],
  pending: []
};

test('feedbackData reads the VM summary and marks thumbs-downs the judges passed', async () => {
  let script;
  const d = await feedbackData(async (s) => ((script = s), JSON.stringify(summary)));
  assert.match(script, /assistant-feedback-triage\/collect\.py --roost/);
  // a: every score passed; b: a judge failed it; c: never scored.
  assert.deepEqual(d.triaged.map((t) => t.judgesPassed), [true, false, null]);
  assert.equal(d.lastRun, '2026-11-15 8:04am down=3 up=2 fixes=1');
});

test('the reader reports a missing summary instead of throwing', async () => {
  const d = await createAssistantFeedbackReader({ host: async () => '' })();
  assert.match(d.error, /No assistant feedback triage yet/);
});
