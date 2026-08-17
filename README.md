# panopticlaude

One sidebar. All your Claudes. Nowhere to hide.

A minimal VSCode tree view that answers two questions at a glance:

- **What are my Claude Code sessions doing right now?** Model, reasoning effort, context %, git branch, linked issue and PR, and whether a session is running, done, or stuck waiting on me.
- **Did my headless Claude bots run today?** Last run status and history for `claude -p` jobs on launchd/cron, plus a badge when a bot left output waiting for review.

Built because the existing Claude dashboards do too much. This is a glanceable tree, not an app.

## Status

v0.1: working. Two tree views (Sessions, Crons) in their own activity-bar container. The design is in [docs/PLAN.md](docs/PLAN.md).

## Install (from source)

```sh
git clone https://github.com/cbrandao18/panopticlaude
ln -sfn "$(pwd)/panopticlaude" ~/.vscode/extensions/panopticlaude
```

Then:

1. Reload VSCode (new windows pick the extension up automatically).
2. Command palette: **Panopticlaude: Install Claude Code Hooks**. This adds the state-reporting hook to five events in `~/.claude/settings.json` (a backup is written next to it). Sessions started before that show a best-effort state from transcript mtime.
3. Point the Crons view at your bots in settings:

```json
"panopticlaude.crons": [
  {
    "label": "com.example.my-bot",
    "log": "~/bots/my-bot/logs/runs.log",
    "inbox": "~/bots/my-bot/drafts"
  }
]
```

If you move the cloned folder, re-run Install Hooks: the hook entries point at the old absolute path.

## How it works

- Sessions come from `~/.claude/sessions/` (the registry behind `claude agents --json`), read directly with a pid-alive check so the 5s poll spawns nothing, then enriched from transcript tails and small hook-written state files
- Session state (running / waiting for you / needs permission) is one shell hook registered on five Claude Code events, writing `~/.claude/panopticlaude/<sessionId>.json`
- Crons: the launchd label resolves the plist schedule and `launchctl` exit status; the log's mtime gives last-run time and drives a "missed today" warning; the inbox file count shows as a needs-review badge
- No marketplace release planned. Symlink from source, or a `.vsix` from Releases.

## Requirements

- Claude Code 2.1.x. This reads undocumented internals (session registry, transcript JSONL) that can shift between releases.
- macOS for the cron section (launchd). The sessions section has no OS-specific parts.
- `gh` CLI for PR links (optional).
