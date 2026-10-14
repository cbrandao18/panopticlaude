# Daily Brief in Orca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude-written daily brief opens as a focused Orca tab each weekday morning and refreshes after the midday crons. The review dashboard runs all the time without Christie starting it.

**Architecture:** A `daily-brief` Claude skill holds all the logic and is run by two Orca automations (8:45 and 13:30 on weekdays) in the existing `~/branch` workspace. The skill writes `~/branch/.context/brief/BRIEF-<date>.md` and opens it with `orca file open --focus`. A launchd LaunchAgent keeps the dashboard server alive, and Orca becomes a login item.

**Tech Stack:** Claude Code skill (Markdown), Orca CLI (`/usr/local/bin/orca`), `gh` (`/opt/homebrew/bin/gh`), claude.ai Slack and Google Calendar connectors, launchd, zsh.

**Spec:** `/Users/christiebrandao/projects/panopticlaude-orca-monitor/docs/superpowers/specs/2026-10-14-daily-brief-design.md`

## Global Constraints

- Timezone America/New_York. Brief triggers: `45 8 * * 1-5` (grace 480 min) and `30 13 * * 1-5` (grace 240 min).
- Workspace selector for `~/branch`: `6d406cee-7837-4da2-b5a9-310bd4badc11::/Users/christiebrandao/branch`.
- Brief file: `/Users/christiebrandao/branch/.context/brief/BRIEF-YYYY-MM-DD.md`. State file: `/Users/christiebrandao/branch/.context/brief/state.json`. `.context/` is git-excluded in `~/branch`.
- The brief is read-only. It never sends, posts, reacts, edits or creates in Slack, Calendar, GitHub or Orca beyond its own files and `orca file open`.
- No customer PII copied from Slack. Link to messages instead.
- Layout: first line is the single next action, then "Today" with at most 3 to-dos, then at most 5 items per section.
- Dashboard URL `http://localhost:55060`. Launcher: `/Users/christiebrandao/branch-workshop/orca-migration/start-review-dashboard`.
- Never kill processes by port. Stop the dashboard only by its known PID.

## Review Focus

1. **First run, no `state.json`:** use the last 24 hours and don't error. Pinned in Task 2, Step 3.
2. **One source fails** (Calendar connector expired, `gh` auth error): one-line notice and the rest of the brief still renders. Pinned in Task 2, Step 4.
3. **Midday run before a cron finishes:** Bots says "still running since HH:MM", not "failed". Pinned in Task 2, Step 5.
4. **Midday run with no morning brief that day** (Orca was closed all morning): write a full brief, not a partial. Pinned in Task 2, Step 5.
5. **Dashboard process dies:** launchd restarts it within seconds. Pinned in Task 3, Step 4.

---

### Task 1: Confirm Orca renders Markdown in a file tab

This decides the output format for every later task.

**Files:**
- Create (scratch): `/Users/christiebrandao/branch/.context/brief/render-check.md`

**Interfaces:**
- Produces: decision `BRIEF_FORMAT` = `md` (open with `orca file open`) or `html` (open with `orca tab create --url file://...`).

- [ ] **Step 1: Write a sample file**

```bash
mkdir -p /Users/christiebrandao/branch/.context/brief
cat > /Users/christiebrandao/branch/.context/brief/render-check.md <<'EOF'
# Render check

**Bold**, a [link](https://github.com/gobranch/branch), and `code`.

- one
- two
EOF
```

- [ ] **Step 2: Open it with another workspace on screen**

Ask Christie to switch Orca to a workspace other than `trunk`, then run:

```bash
/usr/local/bin/orca file open /Users/christiebrandao/branch/.context/brief/render-check.md \
  --worktree '6d406cee-7837-4da2-b5a9-310bd4badc11::/Users/christiebrandao/branch' --focus --json
```

Expected: `"ok": true`. Ask Christie two things: did Orca switch to the tab, and does it show formatted Markdown or raw text? If raw, look for a preview toggle in the tab before choosing `html`.

- [ ] **Step 3: Record the decision and clean up**

```bash
rm /Users/christiebrandao/branch/.context/brief/render-check.md
```

Set `BRIEF_FORMAT` in Task 2's skill. If `html`: the skill also writes `BRIEF-YYYY-MM-DD.html` and opens it with `orca tab create --url file:///Users/christiebrandao/branch/.context/brief/BRIEF-YYYY-MM-DD.html --worktree '<selector>'`. If `--focus` didn't switch views, report that to Christie before continuing.

---

### Task 2: `daily-brief` skill

**Files:**
- Create: `/Users/christiebrandao/.claude/skills/daily-brief/SKILL.md`

**Interfaces:**
- Consumes: `BRIEF_FORMAT` from Task 1.
- Produces: the skill name `daily-brief`, taking the argument `morning` or `midday`, which writes the brief file plus `state.json` `{ "lastBriefAt": "<ISO-8601>", "lastMode": "morning|midday" }`. Task 4's automation prompts invoke it by name.

- [ ] **Step 1: Write the skill**

Write `SKILL.md` with this content (switch the Output step to HTML if Task 1 chose `html`):

````markdown
---
name: daily-brief
description: Use when an Orca automation or Christie asks for the daily brief ("run the daily-brief skill: morning|midday"). Builds today's to-do brief from Calendar, Slack, GitHub, Orca bot runs and held drafts, then opens it in Orca. Read-only.
---

# Daily brief

Argument: `morning` or `midday`. Today is the current date in America/New_York.

Rules:
- Read-only. Never send, post, react, edit, create or delete anything in Slack, Calendar, GitHub or Orca. The only writes are files under `/Users/christiebrandao/branch/.context/brief/` and the `orca file open` call.
- Never copy customer PII (names, addresses, policy/offer/account IDs, emails) from Slack into the brief. Summarize the ask in your own words and link the message.
- Every source is independent. If one fails, write `<Source>: couldn't read — <short reason>` in its section and continue.
- Every "nothing found" line states what was checked and the window, e.g. "No DMs or @mentions since 08:45 yesterday."

## 1. Window

Read `/Users/christiebrandao/branch/.context/brief/state.json`. `since` = its `lastBriefAt`; if the file is missing or unreadable, `since` = now minus 24 hours.

## 2. Gather

- **Calendar** (claude.ai Google Calendar connector): today's events on the primary calendar, 07:00–19:00. Note the next upcoming event and any gap of 60+ minutes as focus time.
- **Slack** (claude.ai Slack connector, `slack_search_public_and_private`): since `since`: DMs to Christie with no reply from her after them; messages that @mention her with no reply from her in the thread; threads she has posted in that have replies after her last message. Drop bot messages and anything she has reacted to with ✅ or 👀.
- **GitHub** (`/opt/homebrew/bin/gh`, repo `gobranch/branch`, user `cbrandao18`):
  - `gh pr list --author @me --state open --json number,title,url,headRefOid,reviewDecision,statusCheckRollup`. For each, flag failing or pending checks on the head commit and unreplied Devlo (`devloai`) review comments.
  - `gh pr list --search "review-requested:@me" --state open --json number,title,url,author`
  - `gh issue list --assignee @me --state open --json number,title,url,updatedAt`
- **Bots**: `/usr/local/bin/orca automations list --json`, then `/usr/local/bin/orca automations runs --id <id> --json` for each automation. For each, report the latest run: status, `startedAt` (local HH:MM), `error`. A run with status other than `completed`/`failed` that started today = "still running since HH:MM". A schedule whose expected run today (time already past) has no run = "missed". Skip the `daily-brief` automations themselves unless their latest run failed.
- **Drafts**: count `DRAFTS-*.md` files in the inbox directories from `~/.config/panopticlaude/monitor.json` (`crons[].inbox`), and compare against `~/.claude/panopticlaude/inbox-seen.json` for unread ones. Link `http://localhost:55060`.

## 3. Write

Path: `/Users/christiebrandao/branch/.context/brief/BRIEF-<YYYY-MM-DD>.md`.

- `morning`, or `midday` when today's file doesn't exist: write the full brief.
- `midday` when today's file exists: keep the Calendar, PRs and Tickets sections, refresh Bots, Drafts and Waiting on you, update the "Next" line and "Today" list, and add `Updated HH:MM` under the title.

Format:

```
# Brief — <Weekday, Mon D>
Next: <one concrete action with link>

## Today
1. <action> — <link>
2. …   (max 3, ranked by deadline/blocking others)

## Calendar
## Waiting on you (Slack)
## PRs
## Tickets
## Bots
## Drafts
```

Max 5 items per section. If there are more, add a final line: `+N more`.

## 4. Save state and open

Write `state.json` as `{"lastBriefAt": "<now ISO-8601>", "lastMode": "<argument>"}`, then run:

```bash
/usr/local/bin/orca file open /Users/christiebrandao/branch/.context/brief/BRIEF-<YYYY-MM-DD>.md \
  --worktree '6d406cee-7837-4da2-b5a9-310bd4badc11::/Users/christiebrandao/branch' --focus --json
```

If it fails, append `Couldn't open in Orca: <reason>` to the brief and stop.
````

- [ ] **Step 2: Run the morning mode by hand**

```bash
cd /Users/christiebrandao/branch && claude -p "Run the daily-brief skill: morning" </dev/null
```

Expected: the brief file exists, `state.json` has `lastMode: morning`, and the tab opens in Orca. Spot-check against the sources: one Slack DM, today's first meeting, and one PR's CI state, each checked directly. Confirm that nothing was sent anywhere: search Slack for her messages from the last 5 minutes and check that `gh api user/events` shows nothing new.

- [ ] **Step 3: First run with no state (Review Focus 1)**

```bash
mv /Users/christiebrandao/branch/.context/brief/state.json /tmp/brief-state.bak
cd /Users/christiebrandao/branch && claude -p "Run the daily-brief skill: morning" </dev/null
```

Expected: the brief's Slack window reads about 24 hours, and a new `state.json` is written. Delete `/tmp/brief-state.bak` afterwards.

- [ ] **Step 4: One source failing (Review Focus 2)**

```bash
cd /Users/christiebrandao/branch && GH_CONFIG_DIR=/tmp/empty-gh claude -p "Run the daily-brief skill: morning" </dev/null
```

Expected: PRs and Tickets each show `couldn't read — …`, and Calendar, Slack and Bots still render.

- [ ] **Step 5: Midday modes (Review Focus 3, 4)**

```bash
cd /Users/christiebrandao/branch && claude -p "Run the daily-brief skill: midday" </dev/null
```

Expected: `Updated HH:MM` appears, and the Calendar and PRs sections are unchanged from the morning run. Then rename today's brief aside (`mv BRIEF-<date>.md /tmp/`) and rerun midday. Expected: a full brief. Restore the original file afterwards. For "still running", run this while a bot is active (`orca automations run <assess-id>`, then immediately run midday). Expected: `still running since HH:MM`.

- [ ] **Step 6: Commit**

The skill lives outside a repo. Note its path in the panopticlaude repo instead:

```bash
cd ~/projects/panopticlaude-orca-monitor && git add docs/superpowers && git commit -m "Daily brief: record skill location and render decision"
```

(Add the Task 1 decision and skill path as a short "Implementation notes" section at the end of the spec before committing.)

---

### Task 3: Always-on dashboard via launchd

**Files:**
- Create: `/Users/christiebrandao/Library/LaunchAgents/com.christie.panopticlaude-dashboard.plist`
- Modify: `/Users/christiebrandao/projects/panopticlaude-orca-monitor/monitor/README.md` (the Orca section)

**Interfaces:**
- Produces: the dashboard reachable at `http://localhost:55060` after login, used by Task 2's Drafts link.

- [ ] **Step 1: Stop the current manually started server by PID**

```bash
pgrep -f "^node .*panopticlaude-orca-monitor/monitor/server.js"   # note PID
kill <PID>
```

- [ ] **Step 2: Write the plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.christie.panopticlaude-dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>/Users/christiebrandao/branch-workshop/orca-migration/start-review-dashboard</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/christiebrandao/branch-workshop/orca-migration/dashboard.out</string>
  <key>StandardErrorPath</key><string>/Users/christiebrandao/branch-workshop/orca-migration/dashboard.err</string>
</dict>
</plist>
```

- [ ] **Step 3: Load it and check**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.christie.panopticlaude-dashboard.plist
sleep 5; curl -s -o /dev/null -w "%{http_code}\n" http://localhost:55060
```

Expected: `200`. If not, read `dashboard.err`. The likely cause is Doppler or keychain access under launchd. If Doppler can't read its token without a GUI session, stop and tell Christie.

- [ ] **Step 4: Restart check (Review Focus 5)**

```bash
kill $(pgrep -f "^node .*panopticlaude-orca-monitor/monitor/server.js"); sleep 35
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:55060
```

Expected: `200`. Then load a draft's Markdown in the browser to confirm `gh` rendering still works under launchd.

- [ ] **Step 5: Retire the Orca terminal and update docs**

Tell Christie to close the Orca terminal titled **Bot review dashboard**; don't close it yourself. In `monitor/README.md`'s Orca paragraph, replace "start the server in a terminal" with the LaunchAgent label and the log paths. Update the memory file `project_claude_mission_control.md` to say the dashboard is now a LaunchAgent.

```bash
cd ~/projects/panopticlaude-orca-monitor && git add monitor/README.md && git commit -m "Dashboard runs as a LaunchAgent"
```

---

### Task 4: Orca automations and login item

**Files:** none (Orca state and macOS login items)

**Interfaces:**
- Consumes: the `daily-brief` skill from Task 2.

- [ ] **Step 1: Create the morning automation**

```bash
/usr/local/bin/orca automations create --name daily-brief --trigger "45 8 * * 1-5" \
  --timezone America/New_York --missed-run-grace-minutes 480 \
  --workspace '6d406cee-7837-4da2-b5a9-310bd4badc11::/Users/christiebrandao/branch' \
  --provider claude --fresh-session \
  --precheck "test -r /Users/christiebrandao/.claude/skills/daily-brief/SKILL.md" \
  --prompt "Run the daily-brief skill: morning" --json
```

- [ ] **Step 2: Create the midday automation**

```bash
/usr/local/bin/orca automations create --name daily-brief-midday --trigger "30 13 * * 1-5" \
  --timezone America/New_York --missed-run-grace-minutes 240 \
  --workspace '6d406cee-7837-4da2-b5a9-310bd4badc11::/Users/christiebrandao/branch' \
  --provider claude --fresh-session \
  --precheck "test -r /Users/christiebrandao/.claude/skills/daily-brief/SKILL.md" \
  --prompt "Run the daily-brief skill: midday" --json
```

- [ ] **Step 3: Check the stored config**

```bash
/usr/local/bin/orca automations list --json
```

Expected: both automations enabled, with `workspaceMode: existing`, `missedRunPolicy: run_once_within_grace`, the grace values above, and `nextRunAt` at the next weekday 8:45 and 13:30 ET.

- [ ] **Step 4: Trigger each once**

```bash
/usr/local/bin/orca automations run <daily-brief-id> --json
```

Expected: the run completes, the brief tab opens focused, and `runs --id` shows `completed`. Repeat for midday.

- [ ] **Step 5: Add Orca to login items**

```bash
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Orca.app", hidden:false}'
osascript -e 'tell application "System Events" to get the name of every login item'
```

Expected: `Orca` is listed. Confirm `/Applications/Orca.app` exists first (`ls -d /Applications/Orca.app`). If it's elsewhere, find it with `mdfind "kMDItemCFBundleIdentifier == '*orca*'"`.

- [ ] **Step 6: Record in memory**

Add a project memory `project_daily_brief.md` with the automation IDs, skill path, brief path, and the LaunchAgent label, plus an index line in `MEMORY.md`.

- [ ] **Step 7: First real morning**

On the next weekday, check before 9:00 that the brief tab is open and the run is `completed`. Report the result to Christie.
