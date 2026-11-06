# Local automation dashboard

The monitor is a localhost dashboard: what is down, what is ready to ship, what is blocked on you, how live releases are going, every automation's status, and an org chart of your agents. The Work page keeps the job logs and draft inbox. Scheduling stays with Orca or launchd; opening this page does not run a job. Node 20 or later is required; there are no dependencies to install.

Copy `monitor/config.example.json` to `~/.config/panopticlaude/monitor.json` and replace the example with your jobs. Entries use the same `label`, `log`, `inbox`, and `repo` fields as VS Code’s `panopticlaude.crons` setting. Add `automationId` from `orca automations list --json` for an Orca job; omit it for launchd. Keep the original label when migrating so inbox review history stays connected. `inbox` and `repo` are optional. `findings` optionally points to a bug sweep `findings.json`; the dashboard serves it at `/api/findings` and the PNGs in the `shots/` folder beside it at `/api/shot`. It also serves `fix.log`, next to the run log, as the `fix` log kind. `name` optionally overrides the display name. Keep this machine-specific config outside the repository.

```sh
source "$HOME/.nvm/nvm.sh"
node monitor/server.js
```

Open `http://localhost:4318`. Use `--port 55060` or `--config /path/to/config.json` to override the defaults. In Conductor, the server uses `CONDUCTOR_PORT` when available.

On this Mac the server runs as the LaunchAgent `com.christie.panopticlaude-dashboard` (`RunAtLoad` + `KeepAlive`), which starts it at login with `--port 55060` and restarts it if it exits; logs go to `dashboard.out` / `dashboard.err` beside the launcher. Open `http://localhost:55060` in a browser tab. Keep the source outside a disposable workspace. The server needs the Orca CLI at `/usr/local/bin/orca` (override with `ORCA_CLI_COMMAND`) and the existing GitHub/Doppler authentication for posting. Use your local credential wrapper when launching; never put credentials in this config or the browser. Stop and restart the server after changing its config.

Orca jobs read their schedule, enabled state, run history, saved output, and errors through the CLI. Launchd jobs keep using their plist and launchctl status.

## Pages

- **Now** (`/`) answers "what needs me", most urgent first:
  - **Down**: vendor status pages, Branch's Datadog monitors on vendor calls (ClarionDoor, Stripe, TransUnion, …), failed or missed automations, a failed feedback watcher, and fresh prod errors the bug sweep would file but hasn't. Borderline findings stay off. Dashed pills are critical things nothing watches yet (Staff uptime, Verisk, …). Vendor lists live at the top of `now-api.js`.
  - **Ready to ship**: your non-draft PRs GitHub would merge now, fixes first.
  - **Blocked on you**: workspaces whose comment starts `You:`, reviews requested of you, Ease decisions, unread held drafts.
  - **Release watch**: one row per live project from its nightly feedback triage log and epic progress (`RELEASES` in `now-api.js`).
  - **Automations**: every Orca automation on the Mac and the VM. "Run finished" means Orca marked it complete, not that the work succeeded; a precheck skip isn't a failure.
  - **Daily brief**, collapsed.
- **Map** (`/map`): an org chart of Orca work. Open or failed coordinator Runs on top, then workspaces by sidebar status, nested by parent. Needs you = `You:` comment; failed = a Run task failed there; stuck = an agent in an unexpected state, or an `Agent:` comment with no activity for a day; quiet = no activity for 3 days (hidden by default). Click a workspace name (or Open in Orca on the Now page) to bring the Orca app to that workspace's first terminal, on the Mac or the VM; the server only accepts workspaces on the current map. Orca has no workspace deep link, so a workspace with no open terminal can't be opened this way.
- **Work** (`/work`): the previous page, unchanged. Ticket work, Ease and Security move to the AI PM agent; the draft inbox goes once assess-assumptions auto-posts.

The Now page reads everything server-side every minute (`/api/now`), with each source failing on its own into the "Couldn't read" line. It needs `gh`, `pup` (Datadog) and the Orca CLI on the Mac, plus `coder ssh` to the VM. Pages use Preact and htm from `monitor/vendor/` (see its README).

## Work page details

- **Ease & effort** lists each #ease-and-effort post the `ease-effort-watch` automation handled, as a tree: the agent's logged steps, then your next moves (decide a ticket draft, dev deploy and mark a PR ready, send the saved Slack reply). It reads `ease.log`, `todo.md` and `todo/ease-*.md` in `~/orca/projects/daily-brief` on the VM over `coder ssh branch-ec2.main` (or locally when the log is on this host), joins Orca workspace names and `gh` PR state, and refreshes every minute. A ticket draft counts as decided once its line leaves `todo.md`; whether you sent the Slack reply isn't tracked.
- **File ticket as drafted** files a not-easy post's ticket draft in `gobranch/branch` as your `gh` user, with issue type Story, after a confirm. It refuses when the Slack link is already on GitHub or the post was filed before, then logs a `filed` line in the VM's `ease.log` and removes the draft's line from `todo.md`. BRANCH TECH fields fill from the draft's `###` headings; check Ticket Type and Dev Sprint after, as the `file-ticket` skill describes.
- Links in Ease & effort open in the Mac's default browser: the page asks the server to run `open` on the link (GitHub and `team-branch.slack.com` https links only), and falls back to a new tab if that fails.
- **Run finished** means Orca marked the latest run completed, including manual test runs. Read its saved output or the run log to confirm the work succeeded. Active runs take precedence over a paused schedule; paused jobs have no next run.
- **Exit 0** means launchd reports a successful process exit. It doesn’t prove the bot completed its intended work. Read the run history or agent output for that.
- **Last log activity** comes from the run log’s modification time, not a recorded start or finish event. **Log overdue** means it hasn’t changed since the latest scheduled run, with a 15-minute grace period.
- Launchd schedules support a daily or weekly `StartCalendarInterval`, matching the VS Code view. Multiple schedule entries use the first entry. Times use your Mac’s timezone.
- The status cards and open log viewer refresh every ten seconds. Draft previews stay on the version you opened; a changed file can’t be marked reviewed until reopened.
- Run history uses the configured `log`. For Orca, Agent output and Run errors come from its latest run; live progress remains in Orca. For launchd, those tabs use `cron.out` and `launchd.err` in the same directory. File log previews show at most the last 64 KB.
- Inbox review state is shared with VS Code in `~/.claude/panopticlaude/inbox-seen.json`. Marking a file reviewed doesn’t delete it. Changed files become unread again.
- Each draft starts collapsed. Expand its title to review the comment as GitHub will render it (via `gh api markdown`, using your own `gh` login), or use Copy comment for the raw Markdown. If rendering fails, the raw text is shown instead. The Post button sends that draft to its linked issue as `ticket-automation[bot]`, using the same token-minting script as the VS Code extension. The monitor process needs Doppler access to the bot credentials; it never falls back to posting as your user.
- Posting checks for closed issues and existing assessment comments. Changed previews and files with a legacy POSTED banner are blocked. Per-comment receipts in the inbox’s hidden `.monitor-posts/` directory preserve posted status across refreshes and restarts, without marking other drafts as posted or reviewed.
- Not posting opens a short form to record why you're skipping a draft: pick any preset reasons and add an optional note. Feedback is saved per comment in the inbox's hidden `.monitor-feedback/` directory and can be edited later. The weekly `assess-assumptions-tuning` automation reads it, along with posted receipts, to adjust the sweep's triage rules.
- If a post times out, its outcome may be unknown. Reopen the draft and use Check post to look for the accepted comment without resending it. If GitHub has no matching comment, the receipt stays blocked for manual investigation. Don’t remove a pending receipt until you’ve confirmed that no comment was created.

The server listens only on `127.0.0.1`, rejects unexpected Host and Origin headers, and serves only configured job logs and inbox files. It doesn’t load third-party assets. Posting accepts only a draft number and source version from a configured inbox; the server supplies the repository, issue, and comment body. Bot credentials stay on the server.

Run the existing tests and monitor HTTP tests with `node --test`.
