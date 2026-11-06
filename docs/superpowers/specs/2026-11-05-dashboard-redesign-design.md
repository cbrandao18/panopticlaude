# Dashboard redesign: "what needs me"

Christie, 2026-11-05. The old page stacked 9 sections (~6,000px) from different sources, each with its own idea of "needs you". The redesign answers one question first: what is urgent, and what needs me personally.

## Pages

- `/` **Now**, in this order:
  1. **Down**: Staff, business-critical vendors (ClarionDoor, Verisk, Stripe, Basis Theory, A+ Auto, …), Claude, failed or overdue automations, prod errors with no ticket. Quiet one-liner when nothing is down.
  2. **Ready to ship**: Christie's PRs GitHub would merge now; fixes and hotfixes first.
  3. **Blocked on you**: agents waiting on her (Orca `You:` comments), PR reviews requested of her, Ease decisions, held assess-assumptions drafts (until auto-post ships).
  4. **Release watch**: live projects watched over weeks, one row each. Signal is the feedback the project's watcher triages (Staff re-skin: `staff-feedback-bot` triage.log + epic #37723).
  5. **Automations**: every Orca automation on the Mac and the VM, one row each. Failed or overdue rows also appear under Down.
  6. **Brief**: the daily brief, collapsed, as a longer less urgent backlog.
- `/map` **Org chart** of work: Runs → workers, workspaces nested by parent, on both hosts; stuck, failed and waiting-on-you nodes highlighted. Unit is agent/job so small single-purpose agents fit later.
- `/work`: the previous page unchanged (ticket work, Ease, Security, draft inbox, job logs). Ticket work, Ease and Security become the AI PM agent (separate project, VM workspace "AI PM agent design"); the draft inbox goes when assess-assumptions auto-post ships (VM workspace "Branch agents (VM)").

## Constraints

- Localhost only, Host/Origin checks, strict CSP (`script-src 'self'`), no third-party assets in the browser. Outbound calls (status pages, gh, pup, orca) happen server-side.
- Helpers: Preact 11 + htm 3, vendored into `monitor/vendor/` with pinned versions and SHA-256, imports rewritten to relative paths (CSP blocks inline import maps). No build step.
- Every source fails independently: one broken reader shows an error row, never a blank page.

## Builder calls (not confirmed by Christie)

- Vendor "down" = public status page where one exists, else Datadog monitors on our integration with that vendor.
- Overdue automation = enabled and `nextRunAt` more than 30 minutes in the past.
- Ready to ship includes all mergeable non-draft PRs; titles starting `fix`/`hotfix` sort first.
- Release watch projects are a list in code until there's a second data shape.
