'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stage, filterTickets, summarize, safeGithubUrl } = require('./ticket-work');
const base = {number:12,repo:'gobranch/branch',title:'Policy renewal',projects:['needs-triage'],category:'Existing work',owner:'Owner needed',state:'OPEN',prs:[]};
test('archive keeps closed issues with open PRs active', () => {
  assert.equal(stage({...base,state:'CLOSED',prs:[{state:'OPEN',isDraft:true}]}),'Draft PR');
  assert.equal(stage({...base,prs:[{state:'MERGED'}]}),'Merged PR');
  assert.equal(filterTickets([{...base,state:'CLOSED'},base],{project:'needs-triage',stage:'active'}).length,1);
});
test('filters combine and literal search handles titles without interpreting markup', () => {
  const ticket={...base,title:'<img onerror=alert(1)> Policy'};
  assert.deepEqual(filterTickets([ticket],{project:'needs-triage',owner:'Owner needed',category:'Existing work',search:'<img'}),[ticket]);
  assert.equal(filterTickets([ticket],{search:'#12'}).length,1);
  assert.equal(filterTickets([ticket],{project:'backlog'}).length,0);
});
test('open followups survive merged archive and action-needed sorts before waiting', () => {
  const waiting={...base,number:1,nextAction:'Wait for CI',actions:[{text:'Wait for CI',state:'open'}]};
  const followup={...base,number:2,prs:[{state:'MERGED'}],actions:[{text:'Verify production follow-up',state:'open'}]};
  assert.deepEqual(filterTickets([waiting,followup],{stage:'active'}).map(t=>t.number),[2,1]);
});
test('summaries distinguish multiple PRs from tickets and unassessed', () => {
  assert.deepEqual(summarize([base,{...base,number:13,category:'Unassessed',prs:[{state:'OPEN'},{state:'OPEN'},{state:'MERGED'}]}]),{tickets:2,assessed:1,unassessed:1,openPRTickets:1,mergedPRs:1,decisions:0});
});
test('links accept only canonical HTTPS GitHub evidence and reject credentials', () => {
  assert.equal(safeGithubUrl('https://github.com/gobranch/branch/issues/12#issuecomment-42'),'https://github.com/gobranch/branch/issues/12#issuecomment-42');
  for(const url of ['javascript:alert(1)','https://github.com.evil.test/x','https://user:secret@github.com/x','http://github.com/x','https://github.com/']) assert.equal(safeGithubUrl(url),null);
});

test('summary counts the same merged PR only once across linked tickets', () => {
  const rows = [1,2].map(number => ({number,repo:'gobranch/branch',category:'Existing work',prs:[{number:99,state:'MERGED'}]}));
  assert.equal(summarize(rows).mergedPRs,1);
});
test('explicit action ranks survive wording and closed decisions are not waiting', () => {
  const low={...base,number:1,nextAction:'Resolve the historical question',nextActionRank:3};
  const high={...base,number:2,nextAction:'Confirm receiving team',nextActionRank:1};
  assert.deepEqual(filterTickets([low,high]).map(t=>t.number),[2,1]);
  assert.equal(summarize([{...base,state:'CLOSED',category:'Needs decision or clarification',actions:[]}]).decisions,0);
});

test('review shortlist uses judgment, deduplicates PRs and separates live blockers', () => {
  const { reviewQueue } = require('./ticket-work');
  const pr=(number,ci='success')=>({number,head:'abc',state:'OPEN',ci,review:'REVIEW_REQUIRED',isDraft:true});
  const rows=[{...base,prs:[pr(1),pr(2,'failure'),pr(3),pr(4),pr(5)]},{...base,number:14,prs:[pr(1)]}];
  const judgment=(pr,rank,head='abc')=>({pr,rank,head,assessedAt:new Date().toISOString(),reason:'Customer impact',nextAction:'Verify',source:`https://github.com/gobranch/branch/pull/${pr}`});
  const queue=reviewQueue(rows,[judgment(1,2),judgment(2,1),judgment(3,3,'old'),{...judgment(4,4),excludedReason:'Test only'}]);
  assert.deepEqual(queue.ready.map(r=>r.pr.number),[1]);
  assert.deepEqual(queue.blocked.map(r=>r.pr.number),[2]);
  assert.deepEqual(queue.unranked.map(r=>r.pr.number),[3,5]);
  assert.equal(queue.excluded.length,1);
});
test('closed PRs leave shortlist and old judgments require reassessment', () => {
  const { reviewQueue }=require('./ticket-work');
  const old={pr:1,rank:1,head:'abc',assessedAt:'2020-01-01',reason:'Impact',nextAction:'Review'};
  const row={...base,prs:[{number:1,head:'abc',state:'OPEN',ci:'success'},{number:2,state:'MERGED'}]};
  const q=reviewQueue([row],[old]);
  assert.equal(q.ready.length,0);assert.equal(q.unranked.length,1);
});
test('a changed excluded PR needs reassessment instead of keeping an old exclusion', () => {
  const {reviewQueue}=require('./ticket-work');
  const q=reviewQueue([{...base,prs:[{number:1,state:'OPEN',head:'new'}]}],[{pr:1,rank:1,head:'old',assessedAt:new Date().toISOString(),excludedReason:'Do not merge test'}]);
  assert.equal(q.excluded.length,0);assert.equal(q.unranked.length,1);
});
