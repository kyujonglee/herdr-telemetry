#!/bin/sh
# Claude Code plan usage as one JSON line: asks the CLI's own get_usage control
# request. Sends no prompt and starts no turn. 127: no CLI, 1: no answer.
bin=${COCKPIT_CLAUDE_BIN:-claude}
command -v "$bin" >/dev/null 2>&1 || exit 127
dir=$(mktemp -d "${TMPDIR:-/tmp}/cockpit-usage.XXXXXX") || exit 1
pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; exec 3>&- 2>/dev/null; rm -rf "$dir"; }
trap cleanup EXIT INT TERM
mkfifo "$dir/in" || exit 1
"$bin" -p --safe-mode --no-session-persistence --input-format stream-json \
  --output-format stream-json --verbose <"$dir/in" >"$dir/out" 2>"$dir/err" &
pid=$!
exec 3>"$dir/in"
printf '%s\n' '{"type":"control_request","request_id":"cockpit-usage","request":{"subtype":"get_usage","skip_behaviors":true}}' >&3
i=0
while [ "$i" -lt 150 ]; do
  line=$(grep -m1 '"control_response"' "$dir/out" 2>/dev/null)
  if [ -n "$line" ]; then printf '%s\n' "$line"; exit 0; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done
exit 1
