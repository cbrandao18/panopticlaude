# Local automation dashboard

The monitor shows Orca automation or launchd job status, schedules, logs, and a draft inbox in a localhost page. Scheduling stays with Orca or launchd; opening this page does not run a job. Node 20 or later is required; there are no dependencies to install.

Copy `monitor/config.example.json` to `~/.config/panopticlaude/monitor.json` and replace the example with your jobs. Entries use the same `label`, `log`, `inbox`, and `repo` fields as VS Code’s `panopticlaude.crons` setting. Add `automationId` from `orca automations list --json` for an Orca job; omit it for launchd. Keep the original label when migrating so inbox review history stays connected. `inbox` and `repo` are optional. `name` optionally overrides the display name. Keep this machine-specific config outside the repository.

```sh
source "$HOME/.nvm/nvm.sh"
node monitor/server.js
```

Open `http://localhost:4318`. Use `--port 55060` or `--config /path/to/config.json` to override the defaults. In Conductor, the server uses `CONDUCTOR_PORT` when available.

In Orca, start the server in a terminal with `--port 55060`, then open `http://localhost:55060` in a browser tab. Keep the source outside a disposable workspace. The server needs the Orca CLI at `/usr/local/bin/orca` (override with `ORCA_CLI_COMMAND`) and the existing GitHub/Doppler authentication for posting. Use your local credential wrapper when launching; never put credentials in this config or the browser. Stop and restart the server after changing its config.

Orca jobs read their schedule, enabled state, run history, saved output, and errors through the CLI. Launchd jobs keep using their plist and launchctl status.

## What the page tells you

- **Run finished** means Orca marked the latest run completed, including manual test runs. Read its saved output or the run log to confirm the work succeeded. Active runs take precedence over a paused schedule; paused jobs have no next run.
- **Exit 0** means launchd reports a successful process exit. It doesn’t prove the bot completed its intended work. Read the run history or agent output for that.
- **Last log activity** comes from the run log’s modification time, not a recorded start or finish event. **Log overdue** means it hasn’t changed since the latest scheduled run, with a 15-minute grace period.
- Launchd schedules support a daily or weekly `StartCalendarInterval`, matching the VS Code view. Multiple schedule entries use the first entry. Times use your Mac’s timezone.
- The status cards and open log viewer refresh every ten seconds. Draft previews stay on the version you opened; a changed file can’t be marked reviewed until reopened.
- Run history uses the configured `log`. For Orca, Agent output and Run errors come from its latest run; live progress remains in Orca. For launchd, those tabs use `cron.out` and `launchd.err` in the same directory. File log previews show at most the last 64 KB.
- Inbox review state is shared with VS Code in `~/.claude/panopticlaude/inbox-seen.json`. Marking a file reviewed doesn’t delete it. Changed files become unread again.
- Each draft starts collapsed. Expand its title to review the exact comment, or use Copy comment. The Post button sends that draft to its linked issue as `ticket-automation[bot]`, using the same token-minting script as the VS Code extension. The monitor process needs Doppler access to the bot credentials; it never falls back to posting as your user.
- Posting checks for closed issues and existing assessment comments. Changed previews and files with a legacy POSTED banner are blocked. Per-comment receipts in the inbox’s hidden `.monitor-posts/` directory preserve posted status across refreshes and restarts, without marking other drafts as posted or reviewed.
- If a post times out, its outcome may be unknown. Reopen the draft and use Check post to look for the accepted comment without resending it. If GitHub has no matching comment, the receipt stays blocked for manual investigation. Don’t remove a pending receipt until you’ve confirmed that no comment was created.

The server listens only on `127.0.0.1`, rejects unexpected Host and Origin headers, and serves only configured job logs and inbox files. It doesn’t load third-party assets. Posting accepts only a draft number and source version from a configured inbox; the server supplies the repository, issue, and comment body. Bot credentials stay on the server.

Run the existing tests and monitor HTTP tests with `node --test`.
