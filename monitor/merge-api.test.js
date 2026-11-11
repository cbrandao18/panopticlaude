const { test } = require('node:test');
const assert = require('node:assert/strict');
const { split, createMergeReader } = require('./merge-api');

const pr = (number, mergeStateStatus, extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/gobranch/branch/pull/${number}`,
  isDraft: false, mergeStateStatus, reviewDecision: 'APPROVED', ...extra });

test('ready holds PRs GitHub would merge without a bypass; drafts are left out', () => {
  const { ready, waiting } = split([
    pr(5, 'UNSTABLE'), pr(1, 'CLEAN'), pr(2, 'HAS_HOOKS'), pr(3, 'CLEAN', { isDraft: true }),
    pr(4, 'BLOCKED', { reviewDecision: 'CHANGES_REQUESTED' }), pr(6, 'DIRTY'), pr(7, 'BLOCKED', { reviewDecision: 'REVIEW_REQUIRED' }),
    pr(8, 'BLOCKED'), pr(9, 'UNKNOWN')
  ]);
  assert.deepEqual(ready.map((p) => [p.number, p.unstable]), [[1, false], [2, false], [5, true]]);
  assert.deepEqual(waiting.map((p) => [p.number, p.reason]), [
    [4, 'changes requested'], [6, 'conflicts with trunk'], [7, 'needs approval'], [8, 'required checks'], [9, 'GitHub still checking']
  ]);
});

test('a failed read returns an error instead of throwing', async () => {
  const read = createMergeReader({ read: () => Promise.reject(new Error('gh: not logged in')) });
  const data = await read();
  assert.match(data.error, /not logged in/);
  assert.deepEqual(data.ready, []);
});

test('review holds drafts with every check passed and no conflicts', () => {
  const ok = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', state: 'SUCCESS' }];
  const draft = (number, mergeStateStatus, statusCheckRollup) => pr(number, mergeStateStatus, { isDraft: true, statusCheckRollup });
  const { review, ready } = split([
    draft(3, 'BLOCKED', ok), draft(1, 'BEHIND', ok),
    draft(4, 'BLOCKED', [...ok, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]),
    draft(5, 'BLOCKED', [...ok, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]),
    draft(6, 'BLOCKED', [...ok, { __typename: 'StatusContext', state: 'PENDING' }]),
    draft(7, 'DIRTY', ok), draft(8, 'BLOCKED', []), pr(9, 'CLEAN', { statusCheckRollup: ok })
  ]);
  assert.deepEqual(review.map((p) => p.number), [1, 3]);
  assert.deepEqual(ready.map((p) => p.number), [9]);
});
