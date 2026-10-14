# Daily brief in Orca: design

Date: 2026-10-14
Status: awaiting Christie's review

## Goal

When Christie starts her day (about 9:00 America/New_York, on weekdays), a Claude-written list of what to do today is already open in Orca. After the midday crons run, the same brief updates with what they did and whether anything needs her review. She shouldn't need to remember to start the dashboard, open it, or check anything.

## Decisions already made

- The brief appears in Orca, not in a browser page she has to visit.
- Sources: GitHub, Google Calendar, Slack, Orca automation history, and held drafts.
- Slack: unanswered DMs and @mentions since the last brief, plus threads she's in that have new replies.
- Orca is added to macOS login items.
- The dashboard runs all the time under launchd, so links to it from the brief always work.

## Verified facts

- A fresh, non-interactive `claude -p` session in `~/branch` gets the claude.ai Google Calendar (9 tools) and Slack (17 tools) connectors. Checked 2026-10-14.
- Orca CLI: `automations create` supports a cron trigger, `--workspace`, `--missed-run-grace-minutes`, and `--fresh-session`. `file open <path> --worktree <sel> --focus` opens a file as a focused tab.
- `~/branch/.context/` is listed in `.git/info/exclude`, so brief files don't dirty the checkout.
- Orca run records have `startedAt` but no finish time. Midday cron runs start at 12:04 and 12:34 (once at 12:47).

## Components

### 1. `daily-brief` skill (`~/.claude/skills/daily-brief/SKILL.md`)

All the brief's logic lives here, so the automation prompts stay one line and changes don't need an Orca edit. It takes one argument: `morning` or `midday`.

Steps:
1. Read `~/branch/.context/brief/state.json` for `lastBriefAt`. If it's missing, use 24 hours ago.
2. Gather each source independently. A failed source becomes one line in the brief ("Slack: couldn't read, <reason>") and the brief continues.
   - **Calendar:** today's events, the next event's start time, and focus gaps of an hour or more.
   - **Slack:** see the scope above, limited to messages since `lastBriefAt`.
   - **GitHub (`gh`, as `cbrandao18`):** her open PRs in `gobranch/branch` with CI state on the head commit, unanswered Devlo findings and review requests; open issues assigned to her; PRs where her review is requested.
   - **Bots:** `orca automations runs` for each configured automation. Report the latest run's status, start time, and error. Flag any scheduled run that is missing or failed.
   - **Drafts:** count of `DRAFTS-*.md` files not yet reviewed, with a link to http://localhost:55060.
3. Write `~/branch/.context/brief/BRIEF-YYYY-MM-DD.md`. A midday run rewrites the same file, keeping the morning sections and refreshing Bots, Drafts and Slack.
4. Update `state.json`.
5. Run `orca file open <path> --worktree <~/branch selector> --focus`.

Output format (written for ADHD mode):
- First line: the single next action.
- "Today": at most 3 ranked to-dos, each a concrete action with a link.
- Then sections for Calendar, Waiting on you (Slack), PRs, Tickets, and Bots. Each has at most 5 items, and a section with nothing to report says so in one line.
- Any count or "nothing found" says what was checked and for what time window.

Read-only rules: the brief never sends, posts, reacts, edits or creates anything in Slack, Calendar, GitHub or Orca beyond its own files and the `file open` call. Customer PII from Slack isn't copied into the file. It refers to the message by link.

### 2. Orca automations

| Name | Trigger | Grace | Prompt |
|---|---|---|---|
| `daily-brief` | `45 8 * * 1-5` | 480 min | `Run the daily-brief skill: morning` |
| `daily-brief-midday` | `30 13 * * 1-5` | 240 min | `Run the daily-brief skill: midday` |

Both use `--workspace` for the existing `~/branch` workspace, `--provider claude` and `--fresh-session`. The grace window means a morning missed while the Mac was asleep still runs when Orca next opens that day.

### 3. Always-on dashboard

LaunchAgent `~/Library/LaunchAgents/com.christie.panopticlaude-dashboard.plist`, with `RunAtLoad` and `KeepAlive` both true, runs `~/branch-workshop/orca-migration/start-review-dashboard`. Logs go to `~/branch-workshop/orca-migration/dashboard.{out,err}`. The Orca "Bot review dashboard" terminal is retired, and the memory and README are updated to say so.

### 4. Orca login item

Add Orca to macOS login items.

## Error handling

- A source fails: the brief shows it in one line, and the rest of the brief is still produced.
- The whole run fails: Orca records the error. The next brief's Bots section reports the failed brief run.
- The brief file can't be opened in Orca: the file still exists, and the next run reports it.
- Midday runs while a cron is still running: Bots shows "still running since HH:MM".

## Testing

1. Before building, open a sample Markdown file with `orca file open --focus` and have Christie confirm whether Orca renders it. If it shows raw text, write the brief as HTML and open it in an Orca browser tab (`tab create --url file://...`) instead.
2. Run the skill by hand (`morning`, then `midday`) and spot-check each section against GitHub, Slack and Calendar directly.
3. `orca automations run <id>` for both automations, then confirm the run status, the file contents and the focused tab.
4. Restart the dashboard by its known PID and confirm launchd brings it back. Log out and back in, then confirm the dashboard and Orca both start.
5. The first real weekday morning: check that the brief is open by 9:00.

## Out of scope

- Posting, replying or triaging from the brief (the dashboard keeps its Post flow).
- Channels beyond DMs, mentions and her own threads.
- Weekend briefs.
