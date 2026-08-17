# Design plan

Investigated and built 2026-08-17 against Claude Code 2.1.232 on macOS. Deviations from the original plan are folded in below (registry read instead of CLI spawn per poll; `PermissionRequest` added as a fifth hook event).

## Goal

One TreeView in the VSCode sidebar, two sections:

1. **Sessions**: every live Claude Code session on the machine, with name, model, effort, context %, state (running / waiting for you / needs permission), git branch, linked issue, PR.
2. **Crons**: headless `claude -p` bots on launchd, with last run status, run history, and a "needs review" badge when a bot leaves files in an inbox directory.

## Data sources (verified live)

| Data | Source |
|---|---|
| Live sessions (pid, sessionId, cwd, name, startedAt) | `~/.claude/sessions/<pid>.json` (the registry `claude agents --json` reads), read directly with a pid-alive check so the 5s poll spawns nothing |
| Model, context tokens, git branch | tail of `~/.claude/projects/<slug>/<sessionId>.jsonl`; the last assistant entry has `message.model`, `message.usage` (input + cache_read + cache_creation = window used), and `gitBranch` |
| Effort | hook payloads carry `effort.level`; fallback is `effortLevel` in `~/.claude/settings.json` |
| Session state | hooks: `UserPromptSubmit` = running, `Stop` = waiting for you, `Notification` (`permission_prompt` / `idle_prompt`) = needs you, `SessionEnd` = gone. Fallback heuristic: transcript mtime < 10s = running |
| Cron schedule | the job's plist in `~/Library/LaunchAgents/` |
| Cron last status | `launchctl print gui/<uid>/<label>` (last exit code) plus the bot's own log file |
| Needs-review badge | file count in a configured inbox directory |
| Issue link | first number of 4+ digits in the branch name |
| PR link | `gh pr list --head <branch> --json number,url`, cached ~5 min per branch |

Notes from verification: there are no per-project `.lock` files in this version, and `~/.claude/ide/*.lock` is only the IDE-integration socket (one per VSCode window). The live-session registry is `~/.claude/sessions/` / `claude agents --json`. Statusline JSON is not used: it's unclear it fires for VSCode-hosted sessions, and hooks plus transcript tails cover everything needed.

## Session state hooks

One shared shell one-liner registered for `UserPromptSubmit`, `Stop`, `Notification`, and `SessionEnd` in `~/.claude/settings.json`, writing `{state, effort, ts}` to `~/.claude/panopticlaude/<sessionId>.json`. The extension watches that directory. The extension should offer an "Install hooks" command (and document the snippet in the README) rather than assume the hooks exist.

## Cron configuration

Everything machine-specific is settings, not code:

```json
"panopticlaude.crons": [
  {
    "label": "com.example.my-bot",
    "log": "~/bots/my-bot/logs/runs.log",
    "inbox": "~/bots/my-bot/drafts"
  }
]
```

`label` resolves the plist and `launchctl print` status; `log` supplies last-run detail and history; `inbox` (optional) drives the needs-review badge. A cron with no run today after its scheduled time shows a warning.

## Build steps

Plain JS, no bundler, no dependencies. Installed by symlinking the repo folder into `~/.vscode/extensions/`.

1. Scaffold `package.json` + `extension.js` with a TreeView showing static rows; symlink, reload, confirm it renders.
2. Sessions provider: `claude agents --json` + last-64KB transcript parse (model / context % / branch). Context window = 1M if the configured model has a `[1m]` suffix, else 200k.
3. State hooks + "Install hooks" command; live-verify with a scratch session before trusting the states.
4. Crons provider: plist + `launchctl print` + log tail + inbox count.
5. Issue/PR links, click actions (open transcript / log / inbox / PR), warning icon for "needs you" rows and missed cron runs.

Refresh: FileSystemWatcher on `~/.claude/panopticlaude/` plus a 5s poll for the rest.

## Known limitations (deliberate)

- Parses undocumented Claude Code internals; pinned expectations to 2.1.x, re-check on upgrade.
- Rate-limit gauges (5h/7d) skipped: that data only exists in statusline JSON.
- Deferred to v2: last-prompt preview per session (`~/.claude/history.jsonl`), cost per session, click-to-focus a session's editor tab.
