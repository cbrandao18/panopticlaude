const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createMonitor}=require('./server');
test('ticket routes use fixed callbacks and reject cross-origin/simple refresh requests',async t=>{
  let starts=0;
  const server=createMonitor({jobs:[],readTickets:()=>({snapshot:null,stale:true}),refreshTickets:()=>{starts++;return true;}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(base+'/api/ticket-work')).json()).stale,true);
  assert.equal((await fetch(base+'/api/ticket-work/refresh',{method:'POST',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await fetch(base+'/api/ticket-work/refresh',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'}})).status,403);
  assert.equal(starts,0);
  assert.equal((await fetch(base+'/api/ticket-work/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,202);
  assert.equal(starts,1);
});
