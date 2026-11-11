#!/bin/sh
# Codex plan limits and the signed-in account as one JSON line:
# {"limits": <account/rateLimits/read reply>, "account": <account/read reply or null>}.
# Sends no prompt. 127: no CLI, 1: no answer.
bin=${TELEMETRY_CODEX_BIN:-codex}
command -v "$bin" >/dev/null 2>&1 || exit 127
dir=$(mktemp -d "${TMPDIR:-/tmp}/telemetry-codex.XXXXXX") || exit 1
pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; exec 3>&- 2>/dev/null; rm -rf "$dir"; }
trap cleanup EXIT INT TERM
mkfifo "$dir/in" || exit 1
"$bin" app-server <"$dir/in" >"$dir/out" 2>"$dir/err" &
pid=$!
exec 3>"$dir/in"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-telemetry","version":"1.0.0"}}}' >&3
i=0
while [ "$i" -lt 150 ]; do
  grep -q '"id":1' "$dir/out" 2>/dev/null && break
  kill -0 "$pid" 2>/dev/null || exit 1
  sleep 0.1; i=$((i + 1))
done
printf '%s\n' '{"jsonrpc":"2.0","method":"initialized"}' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}' '{"jsonrpc":"2.0","id":3,"method":"account/read","params":{}}' >&3
limits= account=
while [ "$i" -lt 150 ]; do
  [ -z "$limits" ] && limits=$(grep -m1 '"id":2' "$dir/out" 2>/dev/null)
  [ -z "$account" ] && account=$(grep -m1 '"id":3' "$dir/out" 2>/dev/null)
  [ -n "$limits" ] && [ -n "$account" ] && break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1; i=$((i + 1))
done
[ -n "$limits" ] || exit 1
printf '{"limits":%s,"account":%s}\n' "$limits" "${account:-null}"
exit 0
