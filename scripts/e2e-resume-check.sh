#!/usr/bin/env bash
#
# scripts/e2e-resume-check.sh — USER-RUN end-to-end check for resume-after-denial.
#
# NOT run by `bun test` or CI. Run it yourself in a normal terminal AND NOT from
# inside an opencode session (the plugin intentionally blocks spawning nested
# gated sessions):
#
#     bash scripts/e2e-resume-check.sh
#
# Why a long-lived server: `opencode run` on its own embeds the plugin in a
# short-lived process, so the fire-and-forget resume loop dies before its idle
# wait completes. Only a `serve` + `run --attach` pair keeps the server (and the
# plugin's resume loop) alive after the run client exits. That is the only
# automated shape that can validate resume end-to-end.
#
# What it does:
#   1. Creates a throwaway directory with a FAKE .env (no real secrets).
#   2. Writes an opencode.json that loads this plugin in enforce mode with a
#      diagnosticsPath in that directory.
#   3. Starts `opencode serve` in the background on a free port (in the throwaway
#      directory, so the project config + plugin load there).
#   4. Polls the server health endpoint until ready (bounded).
#   5. Runs ONE `opencode run --attach http://127.0.0.1:<port> --dir <tmpdir>`
#      asking the agent to print that .env. The plugin's deterministic
#      secret-exposure rule blocks the read and re-prompts the session
#      (resume-after-denial); the resume loop keeps running in the server.
#   6. Sleeps ~12s after the client exits so the idle-wait + started-verification
#      window can complete, then greps the diagnostics JSONL.
#   7. Kills the server (trap EXIT for cleanup).
#
# PASS requires the newest `resume` event to have BOTH "ok":true AND a
# "routing" object carrying an agent — i.e. opencode accepted the continuation
# prompt AND it landed on a routed agent. `started` is informational and printed
# on its own STARTED:true|false|null line; it is NOT part of the PASS criteria.
#
# Env overrides:
#   CALIBRATED_PLUGIN   plugin specifier opencode should load (default: this repo)
#   CALIBRATED_MODEL    optional --model value for `opencode run`
#   KEEP_TMP=1          keep the temp dir for inspection
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_spec="${CALIBRATED_PLUGIN:-$repo_root}"

if ! command -v opencode >/dev/null 2>&1; then
  echo "FAIL: 'opencode' is not on PATH." >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: 'curl' is required for the server health poll." >&2
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/calibrated-e2e.XXXXXX")"
diag="$work/diagnostics.jsonl"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "${KEEP_TMP:-0}" = "1" ]; then
    echo "temp dir kept: $work"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

# A fake secret so the deterministic secret-exposure rule has something to block.
cat > "$work/.env" <<'ENV'
FAKE_API_KEY=sk-fake-not-a-real-secret-do-not-use
ENV

# Load this plugin in enforce mode and route diagnostics into the temp dir.
cat > "$work/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "permission": { "bash": "ask" },
  "plugin": [
    [
      "$plugin_spec",
      {
        "mode": "enforce",
        "diagnosticsPath": "$diag"
      }
    ]
  ]
}
JSON

# Allocate a free port. Node is a documented prerequisite (engines >= 22).
port="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})')"
if [ -z "$port" ]; then
  echo "FAIL: could not allocate a free port." >&2
  exit 2
fi

echo "==> starting opencode server on 127.0.0.1:$port (plugin: $plugin_spec)"
(
  cd "$work"
  exec opencode serve --port "$port"
) > "$work/serve.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 40); do
  if curl -sf -m 2 "http://127.0.0.1:$port/global/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "FAIL: opencode server did not become healthy on port $port."
  echo "--- serve log ---"
  cat "$work/serve.log" 2>/dev/null || true
  exit 1
fi

# The inner agent is asked to run the deterministic-block command exactly once.
prompt='Run exactly this shell command, then stop: cat .env'

echo "==> running one attached opencode session"
run_args=(run --attach "http://127.0.0.1:$port" --dir "$work" "$prompt")
if [ -n "${CALIBRATED_MODEL:-}" ]; then
  run_args=(run --attach "http://127.0.0.1:$port" --dir "$work" --model "$CALIBRATED_MODEL" "$prompt")
fi

opencode "${run_args[@]}" > "$work/transcript.txt" 2>&1 || true

# The resume loop lives in the (still-running) server. Give the idle-wait (up to
# 10s) + started-verification (up to 2s) window time to finish after the client
# exits, then poll a little longer for the fire-and-forget event to land.
sleep 12
i=0
while [ "$i" -lt 20 ] && ! grep -q '"event":"resume"' "$diag" 2>/dev/null; do
  sleep 0.5
  i=$((i + 1))
done

if [ ! -s "$diag" ]; then
  echo "FAIL: no diagnostics were written to $diag."
  echo "      The plugin did not load — check the plugin spec ($plugin_spec) and opencode.json above."
  echo "--- serve log (last 40 lines) ---"
  tail -n 40 "$work/serve.log" 2>/dev/null || true
  echo "--- transcript (last 40 lines) ---"
  tail -n 40 "$work/transcript.txt" 2>/dev/null || true
  exit 1
fi

resume_lines="$(grep '"event":"resume"' "$diag" || true)"
if [ -z "$resume_lines" ]; then
  echo "FAIL: diagnostics exist but contain no 'resume' event (no denial was triggered, or the run ended first)."
  echo "--- all diagnostics ---"
  cat "$diag"
  echo "--- transcript (last 40 lines) ---"
  tail -n 40 "$work/transcript.txt" 2>/dev/null || true
  exit 1
fi

last_resume="$(printf '%s\n' "$resume_lines" | tail -n 1)"
session_id="$(printf '%s\n' "$last_resume" | sed -n 's/.*"sessionID":"\([^"]*\)".*/\1/p')"

if printf '%s' "$last_resume" | grep -q '"started":true'; then
  started_line="true"
elif printf '%s' "$last_resume" | grep -q '"started":false'; then
  started_line="false"
else
  started_line="null"
fi

echo
echo "==> resume_probe events (session ${session_id:-unknown}):"
grep '"event":"resume_probe"' "$diag" 2>/dev/null | grep "\"sessionID\":\"$session_id\"" || echo "  (none)"
echo
echo "==> resume event (newest):"
echo "$last_resume"
echo
echo "STARTED:$started_line"
echo

ok=false
routed=false
if printf '%s' "$last_resume" | grep -q '"ok":true'; then ok=true; fi
if printf '%s' "$last_resume" | grep -q '"routing":{[^}]*"agent"'; then routed=true; fi

if [ "$ok" = "true" ] && [ "$routed" = "true" ]; then
  echo "PASS: continuation accepted (ok:true) and routed to an agent (routing.agent present)."
  exit 0
fi

echo "FAIL: newest resume event lacks ok:true and/or a routing agent."
if [ "$ok" = "false" ]; then
  echo "      The resume prompt was not accepted — see the error detail above."
fi
if [ "$routed" = "false" ]; then
  echo "      The resume event has no routing.agent — the continuation was not routed to an agent."
fi
if [ "$started_line" = "false" ]; then
  echo "      Note: opencode accepted the prompt but the continuation message never appeared (started:false)."
fi
exit 1
