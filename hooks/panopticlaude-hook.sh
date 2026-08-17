#!/bin/sh
# Claude Code hook: records session state for panopticlaude.
# Registered for UserPromptSubmit, Stop, Notification, PermissionRequest, SessionEnd.
# Only flat top-level fields are needed, so sed instead of jq (no dependencies).
IN=$(cat)
SID=$(printf '%s' "$IN" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
EVT=$(printf '%s' "$IN" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
EFFORT=$(printf '%s' "$IN" | sed -n 's/.*"effort"[[:space:]]*:[[:space:]]*{[[:space:]]*"level"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$SID" ] || exit 0
DIR="$HOME/.claude/panopticlaude"
mkdir -p "$DIR"
case "$EVT" in
  UserPromptSubmit)  STATE=running ;;
  Stop)              STATE=waiting ;;
  Notification)      STATE=needs-you ;;
  PermissionRequest) STATE=needs-you ;;
  SessionEnd)       rm -f "$DIR/$SID.json"; exit 0 ;;
  *)                exit 0 ;;
esac
printf '{"state":"%s","effort":"%s","ts":%s}\n' "$STATE" "$EFFORT" "$(date +%s)" > "$DIR/$SID.json"
exit 0
