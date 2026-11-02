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
