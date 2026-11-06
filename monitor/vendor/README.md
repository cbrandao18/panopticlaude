# Vendored browser helpers

Served by `monitor/server.js` from the same origin, so the page keeps `script-src 'self'` and loads nothing third-party.

| File | Package | Source file | npm integrity |
|---|---|---|---|
| `preact.js` | preact 11.1.1 (MIT) | `dist/preact.mjs` | `sha512-vpFVfai437pbuLri7XVeslCPfrEZX6Z1S2gV+MOFrA/kji+NKUXvH7y01EnVjA1guLigfkVp77Sqipd4SIllCg==` |
| `hooks.js` | preact 11.1.1 (MIT) | `hooks/dist/hooks.mjs`, `from"preact"` rewritten to `from"./preact.js"` | same tarball |
| `cabin-latin-{400,600,700}-normal.woff2` | @fontsource/cabin 5.3.0 (OFL-1.1) | `files/` | `sha512-c2NSbpO6XSqaq6E6ztHqgdNxzCPJCxkNvnSEjkQRidlL3Ycac00sS9XTRT6RfMFeB3+C7V3vgN1S40nM6lthuw==` |
| `young-serif-latin-400-normal.woff2` | @fontsource/young-serif 5.3.0 (OFL-1.1) | `files/` | `sha512-/ay2kPm7QzGKW/9tL7UVh+B5meX3J6gh2PLnHV2ohlIbQSMRGTuyzNNVWpzsHc3P3bcpMm1IPfuO7GRtFrXWvQ==` |
| `htm.js` | htm 3.1.1 (Apache-2.0) | `dist/htm.mjs` | `sha512-983Vyg8NwUE7JkZ6NmOqpCZ+sh1bKv2iYTlUkzlWmA5JD2acKoxd4KVxbMmxX/85mtfdnDmTFoNKcg5DGAvxNQ==` |

The import is rewritten because the CSP blocks an inline import map. To update: `npm pack preact@<v> htm@<v>`, compare each tarball's sha512 with `npm view <pkg>@<v> dist.integrity`, copy the files above, redo the rewrite, and update this table.
