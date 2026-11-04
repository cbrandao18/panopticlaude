const test = require('node:test');
const assert = require('node:assert');
const { parseTips } = require('./claude-tips-api');

test('parses the tip shapes the minified CLI uses and skips runtime-only ones', () => {
  const src = [
    '{id:"plain",content:async()=>"Use /memory \\u2014 now",cooldownSessions:5,',
    '{id:"wrapped",priority:2,content:async(e)=>m("wrapped","Use git worktrees",e),cooldownSessions:5,',
    '{id:"styled",content:async(e)=>`Run ${ar("suggestion",e.theme)("/powerup")} \\xB7 go`,cooldownSessions:1,',
    '{id:"block",content:async(e)=>{let n=ar("suggestion",e.theme);return m("block",`Set ${n("/goal")} now`,e)},cooldownSessions:3,',
    '{id:"key",content:async()=>`Use ${nS("chat:imagePaste","Chat","ctrl+v")} to paste`,cooldownSessions:3,',
    '{id:"term",content:async()=>i.terminal==="Apple_Terminal"?"Option+Enter":"Shift+Enter",cooldownSessions:3,',
    '{id:"dynamic",content:async()=>`Hi ${user.name}`,cooldownSessions:3,',
    '{id:"var",content:async()=>$8n,cooldownSessions:3,',
    '{id:"feedback-command",content:async()=>"Use /feedback",cooldownSessions:3,',
    '{id:"plain",content:async()=>"duplicate",cooldownSessions:5,'
  ].join('');
  assert.deepStrictEqual(parseTips(src), [
    { id: 'plain', text: 'Use /memory — now' },
    { id: 'wrapped', text: 'Use git worktrees' },
    { id: 'styled', text: 'Run /powerup · go' },
    { id: 'block', text: 'Set /goal now' },
    { id: 'key', text: 'Use ctrl+v to paste' },
    { id: 'term', text: 'Shift+Enter' }
  ]);
});
