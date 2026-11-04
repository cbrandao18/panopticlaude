// Claude Code's spinner tips, read from the installed CLI so new tips show up after each update.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tips for other platforms, upsells, or setups Christie doesn't use.
const SKIP = new Set([
  'powershell-tool-env', 'vscode-command-install', 'vscode-gpu-accel-garbled-glyphs', 'install-slack-app',
  'install-slack-app-mcp', 'console-api-key', 'feedback-command', 'guest-passes', 'desktop-third-party',
  'c4e-desktop', 'c4e-remote-sessions', 'c4e-ultrareview', 'colorterm-truecolor', 'shift-enter-setup', 'web-app'
]);

const unescape = (s) => s
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\n/g, ' ')
  .replace(/\\(.)/g, '$1');

// Turns one minified `content:` function into plain text, or null when it's computed at runtime.
function tipText(body) {
  let s = body.trim().replace(/,$/, '').replace(/^async\s*\(\w*\)\s*=>\s*/, '');
  s = s.replace(/^\{let \w+=[^;]*;return ([\s\S]*)\}$/, '$1'); // { let style = ...; return text }
  s = s.replace(/^\w+\("[\w-]+",([\s\S]*),\w+\)$/, '$1'); // m("id", text, e)
  s = s.replace(/^[\w.]+===?"[^"]*"\?(?:"[^"]*"|`[^`]*`):/, ''); // terminal === X ? a : b → b
  let m = s.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return unescape(m[1]);
  m = s.match(/^`((?:[^`\\]|\\.)*)`$/);
  if (!m) return null;
  const text = m[1]
    .replace(/\$\{\w+\("[^"]*","[^"]*","([^"]*)"\)\}/g, '$1') // ${key("chat:x","Chat","shift+tab")}
    .replace(/\$\{\w+(?:\([^()]*\))?\((?:"([^"]*)"|'([^']*)')\)\}/g, '$1$2'); // ${style(...)("/cmd")} or ${n("/cmd")}
  return text.includes('${') ? null : unescape(text);
}

function parseTips(text) {
  const tips = new Map();
  for (const m of text.matchAll(/\{id:"([a-z0-9-]+)",(?:[^{}]{0,120}?)content:([\s\S]{0,600}?)cooldownSessions:/g)) {
    const [, id, body] = m;
    if (tips.has(id) || SKIP.has(id)) continue;
    const tip = tipText(body);
    if (tip) tips.set(id, tip);
  }
  return [...tips].map(([id, tip]) => ({ id, text: tip }));
}

// shortcut: reads the whole ~300 MB binary once per Claude Code version; stream it if memory ever matters.
function createTipsReader(bin = path.join(os.homedir(), '.local/bin/claude')) {
  let cache = { real: null, data: null };
  return async () => {
    const real = await fs.promises.realpath(bin);
    if (cache.real !== real) {
      const buf = await fs.promises.readFile(real);
      const start = buf.indexOf('cooldownSessions:');
      const end = buf.lastIndexOf('cooldownSessions:');
      const tips = start < 0 ? [] : parseTips(buf.toString('latin1', Math.max(0, start - 2000), end + 20));
      cache = { real, data: { version: path.basename(real), tips } };
    }
    return cache.data;
  };
}

module.exports = { createTipsReader, parseTips, tipText };
