const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ticketData, createRefresh } = require('./ticket-work-api');
test('missing or malformed snapshots remain unavailable, stale and explicit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(ticketData(dir).snapshot,null);
  fs.writeFileSync(path.join(dir,'snapshot.json'),'{');
  assert.equal(ticketData(dir).stale,true);
  assert.match(ticketData(dir).health.error,/snapshot/i);
});
test('fresh records retain transport errors and last-good data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schema:1,refreshedAt:new Date().toISOString(),projects:[],tickets:[]}));
  fs.writeFileSync(path.join(dir,'health.json'),JSON.stringify({error:'VM offline',running:false}));
  assert.equal(ticketData(dir).snapshot.schema,1);
  assert.equal(ticketData(dir).stale,true);
  assert.equal(ticketData(dir).health.error,'VM offline');
});
test('refresh does not start a duplicate subprocess', async () => {
  let finish, calls=0;
  const run=()=>{calls++; return new Promise(r=>finish=r);};
  const refresh=createRefresh(run);
  assert.equal(refresh(),true);
  assert.equal(refresh(),false);
  await new Promise(setImmediate);
  assert.equal(calls,1);
  finish(); await new Promise(setImmediate);
  assert.equal(refresh(),true);
  await new Promise(setImmediate);
  finish();
});
test('invalid nested renderer fields are not exposed as a snapshot', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tickets-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schema:1,refreshedAt:new Date().toISOString(),projects:[],tickets:[{repo:'gobranch/branch',number:1,url:'https://github.com/gobranch/branch/issues/1',projects:null,actions:'bad'}]}));
  assert.equal(ticketData(dir).snapshot,null);
});
test('a refresh subprocess failure remains visible even before wrapper health exists', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tickets-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'snapshot.json'),JSON.stringify({schema:1,refreshedAt:new Date().toISOString(),projects:[],tickets:[]}));
  createRefresh(()=>Promise.reject(Error('private raw output')))();
  await new Promise(setImmediate);
  assert.equal(ticketData(dir).stale,true);
  assert.match(ticketData(dir).health.error,/could not complete/);
  assert(!ticketData(dir).health.error.includes('private raw output'));
});
test('judgment metadata validates independently without discarding live status', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tickets-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'priorities.json');
  fs.writeFileSync(file,JSON.stringify([{pr:1,rank:1,head:'a'.repeat(40),reason:'Impact',nextAction:'Review',assessedAt:new Date().toISOString(),source:'https://github.com/gobranch/branch/pull/1'}]));
  assert.equal(ticketData(dir,file).priorities.length,1);
  fs.writeFileSync(file,JSON.stringify([{pr:1,rank:1,source:'javascript:evil'}]));
  assert.equal(ticketData(dir,file).priorities.length,0);
  assert.match(ticketData(dir,file).priorityError,/priorit/i);
});
