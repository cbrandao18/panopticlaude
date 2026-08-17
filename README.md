# panopticlaude

One sidebar. All your Claudes. Nowhere to hide.

A minimal VSCode tree view that answers two questions at a glance:

- **What are my Claude Code sessions doing right now?** Model, reasoning effort, context %, git branch, linked issue and PR, and whether a session is running, done, or stuck waiting on me.
- **Did my headless Claude bots run today?** Last run status and history for `claude -p` jobs on launchd/cron, plus a badge when a bot left output waiting for review.

Built because the existing Claude dashboards do too much. This is a glanceable tree, not an app.

## Status

Design phase. Nothing works yet. The design is in [docs/PLAN.md](docs/PLAN.md).

## Planned shape

- Sessions enumerated with `claude agents --json`, enriched from transcript tails and small hook-written state files
- Session state (running / waiting for you / needs permission) via four one-line Claude Code hooks you add once
- Crons are config-driven: point a setting at your launchd label, log file, and optional "inbox" directory
- No marketplace release planned. Install will be a folder symlinked into `~/.vscode/extensions/`, or a `.vsix` from Releases.

## Requirements (planned)

- Claude Code 2.1.x. This reads undocumented internals (session registry, transcript JSONL) that can shift between releases.
- macOS for the cron section (launchd). The sessions section has no OS-specific parts.
- `gh` CLI for PR links (optional).
