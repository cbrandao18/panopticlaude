# Bug sweep (dd-triage-bot + Sentry + LogRocket): design

Date: 2026-10-22
Status: awaiting Christie's review

## Why

Today `dd-triage-bot` turns Datadog errors into tickets, but problems that never throw to Datadog stay invisible unless someone reports them. That covers front-end errors, confusing screens and broken affordances. The back caret on tool run pages pointed the wrong way for weeks before Christie found it herself ([#36819](https://github.com/gobranch/branch/pull/36819)). Datadog, Sentry and LogRocket each see part of a bug: the backend error, the front-end error, and what the user actually saw. Today nothing connects them.

Success: one daily sweep turns all three sources into tickets in #ai-created-issues. A defect seen in more than one source becomes one ticket with all the evidence. The dashboard shows every finding. Simple bugs already have a fix PR in review.

## Goals

- Grow `dd-triage-bot` in place into a bug sweep with three sources:
  - Datadog, for all prod, as today
  - Sentry, for staff-fe errors
  - LogRocket, for staff-fe sessions, screenshots and friction signals
- Cross-correlate the three sources, so one defect gets one ticket listing every source that saw it.
- Catch UI problems that throw no error, by having Claude review LogRocket screenshots.
- Show results on the panopticlaude dashboard: every finding, its sources, counts, ticket, fix status and a screenshot.
- After each run, fix simple bugs from any source through the hotfix flow: PR, Devlo loop, CI, never merged.

## Non-goals

- Sentry and LogRocket for quote-fe and account-fe. Those come later, once staff-fe works.
- Real-time alerting.

## Anti-goals

- **Breaking what `dd-triage-bot` does today.** That covers:
  - the three prod envs and the service exclusions
  - Joe/Mutuals routing
  - release regression checks
  - the #ai-created-issues post format
  - the dedupe history
- Noisy tickets. One screenshot produced 24 findings in testing, most of them low value. Tickets reach other devs through #ai-created-issues, so a nitpick ticket costs more than a missed one.
- Filing the same defect twice because two sources saw it.
- Customer PII in GitHub or Slack. Staff sessions show member names, addresses and policy details.
- Silence that looks like "no bugs". A source that fails must be reported.
- A second daily schedule.

## What the new sources catch

From the kinds of fixes in Christie's staff-fe PRs, most common first:

1. Tool output that's hard to read: raw JSON or raw keys as labels, columns named "0", no clear pass or fail ([#36819](https://github.com/gobranch/branch/pull/36819)).
2. Status that misleads: "Execution timed out" when the run worked, "In Progress" that never updates ([#36819](https://github.com/gobranch/branch/pull/36819)).
3. Silent failures: a request fails and no error appears, or an error dialog closes on its own ([#36635](https://github.com/gobranch/branch/pull/36635), [#35448](https://github.com/gobranch/branch/pull/35448)).
4. Dead clicks: something looks clickable and does nothing ([#33429](https://github.com/gobranch/branch/pull/33429)).
5. Visual and copy problems: icons pointing the wrong way, wrong or low-contrast colors, wrong helper text, numbers that disagree on one screen ([#36385](https://github.com/gobranch/branch/pull/36385), [#36591](https://github.com/gobranch/branch/pull/36591)).
6. Front-end errors staff hit (Sentry), when they break or block what the user was doing.

Her 30-day friction analysis ([#33194](https://github.com/gobranch/branch/issues/33194)) is the manual version of the LogRocket part.

## Verified facts (2026-10-21)

### dd-triage-bot today

- **Automation:** Orca automation `0a619205-c823-413a-ae7a-2b977c57af47`. It runs daily at 12:04pm America/New_York in `~/branch` with Claude, a fresh session each run, and 1440 min grace.
- **Prompt:** it reads `~/branch-workshop/dd-triage-bot/PROMPT.md` every run.
- **Auth:** every credentialed command goes through `~/branch-workshop/orca-migration/with-bot-env`. That gives it `DD_*`, `SLACK_AI_CREATED_ISSUES_WEBHOOK`, `SLACK_DEV_ESCALATION_ANALYSIS_TOKEN` and bot-token minting. It also has `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `LOGROCKET_MCP_API_KEY`, which are unused so far.
- **PROMPT.md steps:**
  1. Pull
  2. Dedupe
  3. Noise
  4. Validity
  5. Evidence, plus 5b, the release regression check
  6. File, plus 6b, the Monday log lens; and 6c, the #ai-created-issues post
  7. Run summary to `logs/runs.log`
- **Dashboard:** it's already a dashboard job (`com.christie.dd-triage-bot`), with a log and no inbox.

### LogRocket

- The claude.ai connector works for Christie's account. The first sign-in was the wrong account and got 403 on every call. Later in the same session the claude.ai LogRocket and Sentry connectors dropped out of the configuration, so connector availability is fragile.
- Use `branch-production` as `projectID`. Session links are `https://app.logrocket.com/ydvp81/branch-production/s/<recordingID>/<sessionID>`.
- Staff users have IDs starting `staff-`. The project includes mutual staff apps: a CFM-branded staff session was seen.
- `find_sessions` filters by URL substring and date. Tool run pages are `<tool path>/run/<YYMM>/<runId>`.
- `watch_sessions` returns key frames with a `screenshotURL`, and `curl -L` fetches the PNG without auth. `get_network_entries` returns a session's requests and responses as HAR.
- **LogRocket's own watcher missed the caret.** On a pre-fix run page it answered "None found", while its own key frame showed the right-pointing caret.
- **Claude reviewing the PNG caught it.** A fresh agent with only the screenshot and a generic reviewer prompt listed the caret first, with high confidence. It also found raw lowercase column headers, "60 messages" next to "1-15 OF 59", and 21 lower-value items.

### Sentry

- Org `branch-t3`, project `staff-fe` (ID 1501891). `search_issues` returns production issues with user counts. Some are user-facing, like "Offer-flow system error reported" (16 users). Some aren't, like analytics `track()` warnings (352 users).
- Staff-fe has no Sentry replays.

### Not verified

- Which keys actually link the sources. Candidates:
  - staff username, which is Sentry user, LogRocket `staff-<username>` and Datadog request context
  - time window plus GraphQL operation name
  - request IDs in LogRocket network entries matched against Datadog logs
- Whether an Orca automation session gets the claude.ai LogRocket and Sentry connectors. The daily brief's automation does get claude.ai Slack and Calendar.

## Decisions made with Christie

- Collapse the UI sweep into `dd-triage-bot`, growing it in place (the recommended option).
- Sentry and LogRocket cover staff-fe. Datadog keeps covering all prod.
- Every finding that clears the bar is ticketed and posted to #ai-created-issues with the existing mechanics.
- The dashboard shows results from all three sources.
- The fixer takes simple bugs from every source, with no daily limit.
- The fixer may use Codex to drive Firefox and upload PR screenshots without warning her first. This applies to this flow only.
- The fixer never deploys. When nothing is deployed, the PR's testing section is left empty.
- New steps go live through a dry-run cutover. There's never a second schedule.
- **Fixers take only tickets the sweep files after cutover.** They skip a ticket if any of these is true:
  - its BRANCH TECH Software Dev field is set (GitHub assignees don't count)
  - its BRANCH TECH Status is In Progress (Dev) or later
  - it has a linked branch or PR
  - someone has commented that they're taking it
  - it's Joe/Mutuals-routed
  
  Pre-existing Datadog tickets are never picked up.
- **Fixers reproduce against Christie's `dev_christie` stack**, signed in as `stafftest`. They may create synthetic test data there (fake names, quotes, offers) and never deploy to it.

## Calls Claude made (check these)

- **Schedule stays daily at 12:04pm**, so the 1:30pm midday brief reports the run. Moving it means also updating the scheduler note in Christie's global instructions.
- **One fix PR per ticket**, each in its own workspace, like hotfixes. It isn't one PR per day, because Datadog and UI fixes in different services shouldn't be reviewed as a bundle. The existing 10 GB free-disk guard limits how many run at once.
- **Mutual routing for UI findings.** A LogRocket or Sentry finding seen only on a mutual's staff app follows the existing Joe/Mutuals routing.
- **The bot keeps its name** (`dd-triage-bot`) and paths, so history, the dashboard label and the automation ID survive. Only the dashboard display name changes, to "Bug sweep".
- **Connectors first, API keys as backup, and the backup is in scope.** LogRocket and Sentry use the claude.ai connectors. Both dropped out of the design session twice, so the API-key paths are built and tested before the dry run:
  - Sentry falls back to its REST API with `SENTRY_AUTH_TOKEN` through `with-bot-env`.
  - LogRocket gets a key-based MCP server for the `~/branch` project: `https://mcp.logrocket.com/mcp`, local scope so no tracked files change. A `headersHelper` gets `LOGROCKET_MCP_API_KEY` through `with-bot-env`, so the key never sits in config.
  - When both paths fail, it's a reported source failure.

## How it works

### PROMPT.md changes

The existing steps stay as they are, except where noted below.

**Step 1b: Pull Sentry.**
- `search_issues` on `branch-t3/staff-fe`, `environment:production`, active in the last 24h, sorted by users.
- Drop issues with no user-facing effect, such as analytics `track()` warnings and third-party script noise.
- Keep errors that break, block, or show an error to the user.

**Step 1c: Pull LogRocket.**
1. `find_issues` for the last 24h, all types, severity `any`, staff URLs only.
2. Pick about 20 `staff-` sessions:
   - sessions behind the friction issues
   - sessions matching the Sentry issues kept in 1b, and the staff-fe-related Datadog candidates, by user and time
   - sessions on pages changed by staff-fe PRs merged in the last 7 days
   - a few others, spread across quote, offer, policy, customer and Tools
3. Ask `watch_sessions` for a key frame of every distinct page or dialog, with its URL, and download each PNG to `~/branch-workshop/dd-triage-bot/shots/`.
4. Normalize URLs to routes and review at most 2 screenshots per route.
5. Claude reviews the PNGs with the rubric in "What the new sources catch". Keep only high-confidence findings that would plausibly earn a fix PR like the examples. LogRocket's text answers aren't used for judging.

**Step 1d: Correlate.**
- Group candidates from all three sources into findings, using the keys in "Not verified" above. The dry run settles which keys hold up.
- A finding carries every source's evidence and counts. For example: a Datadog error in `staffraterlambda`, plus Sentry "No parseable response" (35 users), plus the LogRocket sessions where staff saw it.
- Each finding gets a stable key. For Datadog findings, the existing DD issue UUID stays the primary dedupe key. Others use `<route>:<slug>` or the Sentry short ID.

**Step 2: Dedupe** runs per finding, searching every source's key: DD UUID, Sentry short ID, LogRocket key and route. A finding that matches an existing ticket from any source is a duplicate. If it adds a new source, record that locally in `findings.json`. Don't comment on the ticket, keeping the existing "never comment" rule.

**Steps 3 and 4: Noise and validity.** The existing Datadog rules stay. New sources use this filing bar:
- Clearly visible on screen: 1 session.
- Friction: 2 or more sessions.
- Sentry: 2 or more users.
- If unsure, list it as borderline, not filed.

**Step 5: Evidence.**
- **UI findings:** `build_metric` gives sessions per day on that route.
- **Sentry and LogRocket stack traces or components:** blame them the same way.

**Step 6: File** with the existing mechanics:
- **Titles:**
  - Datadog-led findings keep `[Bug AI Automation] <service>: ...`.
  - UI findings use `[Bug AI Automation] staff-fe: <defect> (~N sessions/day)`.
- **Body:** gets an **Evidence** block with one line per source: the DD issue link, the Sentry issue link, and LogRocket session links with `?t=`.
- **PII:** no LogRocket screenshots in tickets, and no customer names, addresses or policy numbers.

**Step 6c: #ai-created-issues post.** Same format, with the sources listed on the second line, for example `· DD + Sentry + LogRocket`.

**Step 6e: Start fixers.**
- For each ticket filed this run, and any sweep ticket filed since cutover that has no fix attempt, run `start-bug-fix.sh <issue number>`.
- The script applies the skip rules from "Decisions made with Christie" itself, so they're deterministic.

**Step 7: Run summary.**
- Add per-source lines: `sentry: N issues, N kept`, `logrocket: N sessions, N routes, N findings`, `correlated: N`, `fixers: started N`.
- Write `findings.json`.

**Hard rules.** "Read-only with respect to the repo" still holds for the sweep. Fixers run in their own workspaces.

### findings.json (`~/branch-workshop/dd-triage-bot/findings.json`)

One record per finding, holding:
- key and title
- sources, each with its link, count and first and last seen
- route or service, and env
- the screenshot file name
- ticket number
- fix status: none, pr, not-simple, blocked or merged
- last updated

The sweep writes every finding, filed or not. Borderline findings are marked so. On first run, backfill the bot's open `[Bug AI Automation]` tickets from GitHub so Datadog history shows on the dashboard.

Screenshots in `shots/` are deleted after 14 days. They never leave the machine.

### Fixer (`~/branch-workshop/dd-triage-bot/start-bug-fix.sh <issue>`)

It's a copy of `start-hotfix.sh` with these differences:
- the workspace is `bugfix-<issue>` off `origin/trunk`
- it prints `skip: <reason>` if the workspace exists, disk is low, the ticket was filed before cutover, or any ownership rule above applies

Other mechanics are unchanged: Claude with Orca's default model, Slack writes and `gh pr merge` disallowed, and the folder-trust prompt answered.

The agent's prompt:
- Read the ticket and its evidence. Reproduce the bug first:
  - UI bugs in local staff-fe with headless Chrome, using Doppler config `dev_christie`, signed in as `stafftest`, with synthetic test data created as needed
  - backend bugs with a failing test
  
  Each fixer picks a free Vite port so several can run at once.
- Fix only if it's simple. Simple means what it means for hotfixes: a small change in one area, a regression test that fails before and passes after, no migration, no infra or config change, no product decision. Copy changes use `branch-copywriter`.
- Open a PR with `Closes #N`, following the PR template and Christie's PR rules. Leave the testing instructions section empty, since nothing is deployed.
- **UI fixes only:** take before and after screenshots from local staff-fe. Upload them with `codex exec` and Computer Use in Firefox, without warning her first. Read the body back to confirm one `user-attachments` URL per screenshot.
- Run the Devlo loop and CI to an all-clear. Never merge, never deploy, never comment on the ticket.
- If the fix isn't simple, stop and record the reason in the log.
- Log to `~/branch-workshop/dd-triage-bot/logs/fix.log`: `started #N`, `pr #N <url>`, `not-simple #N: <reason>`, `clear #N <url>`, `blocked #N <url> <pending>`. Update `findings.json`.

### Dashboard

The existing `com.christie.dd-triage-bot` card is renamed "Bug sweep" and shows results.

**Header:**
- last run time
- per-source status: OK, failed or missing
- counts: issues seen, sessions reviewed, filed, correlated
- links to the run log and the fix log

**Findings table** from `findings.json`, newest first:

| Column | Shows |
|---|---|
| Screenshot | thumbnail if there is one; click to enlarge |
| Finding | title |
| Where | route or service, and env |
| Sources | a DD, Sentry or LogRocket badge for each source, each a link with its count |
| Seen | first and last seen |
| Ticket | link to the ticket |
| Fix | none, PR open, not simple, blocked or merged |

- A filter for source and fix status.
- Findings not seen in 14 days, or with closed tickets, collapse into a "Resolved or quiet" section.
- Borderline, unfiled findings sit in their own collapsed section, so Christie can promote one by hand.

**Changes:**
- **Config:** add `findings` to the job's entry in `~/.config/panopticlaude/monitor.json`.
- **`monitor/server.js`:**
  - serve the configured `findings.json`
  - serve `shots/` images by bare file name, rejecting path traversal
- **`monitor/app.js` and `style.css`:** the card and the table.
- **Tests:** in `server.test.js` for the new routes, including traversal rejection.
- **Restart** the dashboard LaunchAgent.

The server already listens only on `127.0.0.1` and checks Host and Origin.

### Daily brief

The midday brief gains a "Bug sweep" section, which stays read-only:
- tickets filed since `lastBriefAt`, each with its sources and a link
- any source failures
- a link to the dashboard card

From `fix.log`:
- `pr` lines go in "Today" as "review the fix PR".
- `not-simple` and `blocked` lines go in "Today" with their reason.

### Other updates

- `~/branch-workshop/dd-triage-bot/` gets the new files above.
- **Automation prompt:** add approval for starting fixers, and for fixers' PRs and Codex screenshot uploads. Bump the precheck to also test `start-bug-fix.sh`.
- **Global instructions:** the "Scheduled Datadog Triage" section of Christie's `~/.agents/AGENTS.md` names this bot as the only sweep. Update its wording to cover Sentry and LogRocket. Christie approves that edit separately.
- **daily-brief `AGENTS.md`:** note the new brief section.

## Cutover

1. **Dry run on a past window (October 13 to 20).** Run Steps 1b to 5 by hand and write would-be tickets to `DRYRUN-BUGSWEEP-<date>.md`, the way the bot's earlier dry runs worked. Check four things:
   - The caret appears.
   - Every would-be ticket is something Christie would fix.
   - Correlation joins at least one real Datadog, Sentry and LogRocket triple, or shows which keys don't work.
   - Datadog-only output matches what the bot filed that week.
2. **Live dry runs.** The scheduled run files Datadog tickets as today and writes the new sources' would-be tickets to the dry-run file. Fixers stay off.
3. **Christie reviews the dry-run file**, then switches on filing for the new sources, and fixers after that.

## Constraints

- Screenshots and LogRocket answers contain customer PII. They stay in `shots/` and the local dashboard.
- `watch_sessions` can take several minutes per batch. Poll until every fingerprint finishes, or 20 minutes pass, then continue and say so.
- The run gets longer. If it nears Orca's limits, LogRocket review is the step to trim: fewer sessions.

## Left to the builder

- Exact PROMPT.md wording and the screenshot rubric prompt, keeping the high-confidence filter and the filing bar.
- Correlation mechanics, once the dry run shows which keys work.
- The `findings.json` schema, as long as it fills the dashboard columns.
- How changed files map to routes, and how screenshot cleanup runs.
- Dashboard layout details, following the existing card and table styles.
