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
