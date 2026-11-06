# Vendored browser helpers

Served by `monitor/server.js` from the same origin, so the page keeps `script-src 'self'` and loads nothing third-party.

| File | Package | Source file | npm integrity |
|---|---|---|---|
| `preact.js` | preact 11.1.1 (MIT) | `dist/preact.mjs` | `sha512-vpFVfai437pbuLri7XVeslCPfrEZX6Z1S2gV+MOFrA/kji+NKUXvH7y01EnVjA1guLigfkVp77Sqipd4SIllCg==` |
| `hooks.js` | preact 11.1.1 (MIT) | `hooks/dist/hooks.mjs`, `from"preact"` rewritten to `from"./preact.js"` | same tarball |
| `htm.js` | htm 3.1.1 (Apache-2.0) | `dist/htm.mjs` | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` |

The import is rewritten because the CSP blocks an inline import map. To update: `npm pack preact@<v> htm@<v>`, compare each tarball's sha512 with `npm view <pkg>@<v> dist.integrity`, copy the files above, redo the rewrite, and update this table.
