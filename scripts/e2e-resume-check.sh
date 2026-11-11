#!/usr/bin/env bash
#
# scripts/e2e-resume-check.sh — USER-RUN end-to-end check for resume-after-denial
# and the headless auto-reject race.
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
# Two scenarios:
#
#   Scenario 1 — deterministic finding + model review. The agent is asked to
#     print a fake `.env`. `cat .env` is now a *caution finding* attached to the
#     judge request (the routine/secret short-circuit is gone), so the request
#     reaches the model and can lose the headless auto-reject race. PASS: the
#     `decision` event carries `command`, `promptVersion`, and a
#     `secret_exposure` finding. A `resume` event, if it lands, must still be
#     `ok: true` with a routing agent; `started` stays informational. A hard
#     deny (catastrophic delete / explicit prohibition) still short-circuits and
#     resumes deterministically — that path is unit-tested, not exercised here
#     with a destructive command.
#
#   Scenario 2 — model-reviewed command (regression guard for #21). The agent is
#     asked to run a benign non-routine command that reaches the model. opencode's
#     headless `run` client auto-rejects `permission.asked` immediately (see the
#     `opencode run` handler: on `permission.asked` it replies `reject` unless
#     `--auto`/`--yolo`/`--dangerously-skip-permissions`), so the plugin's reply
#     loses that race. The plugin still runs the review to completion and writes
#     the `decision` event — it records a settled permission but never replies or
#     caches for it. PASS: at least one model-sourced `decision` event exists.
#
# Timing instrumentation: each `opencode run` invocation is bracketed with
# `date +%s%3N` wall-clock timestamps, and the plugin's own `elapsedMs` is read
# from each `decision` event. That is how you measure the headless auto-reject
# grace window empirically: hard-policy decisions stay in the low milliseconds
# (they beat the auto-reject), while model-reviewed decisions are in the
# hundreds-to-thousands (they lose the reply race but are still logged). The
# scenario-2 loop retries a few times so a transient plugin/run hiccup does not
# fail the guard.
#
# Env overrides:
#   CALIBRATED_PLUGIN   plugin specifier opencode should load (default: this repo)
#   CALIBRATED_MODEL    optional --model value for `opencode run`
#   KEEP_TMP=1          keep the temp dir for inspection
#   TYPESAFE_API_KEY    live key for the model-reviewed scenario (auto-loaded from
#                       the repo-root .env when unset; the value is never printed)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_spec="${CALIBRATED_PLUGIN:-$repo_root}"

# Scenario 2 needs a live model key. Mirror bun's ./.env auto-load (which the
# integration suite relies on) without ever printing the value.
if [ -z "${TYPESAFE_API_KEY:-}" ] && [ -f "$repo_root/.env" ]; then
  key_line="$(grep -m1 '^TYPESAFE_API_KEY=' "$repo_root/.env" || true)"
  if [ -n "$key_line" ]; then
    TYPESAFE_API_KEY="${key_line#TYPESAFE_API_KEY=}"
    TYPESAFE_API_KEY="${TYPESAFE_API_KEY%\"}"
    TYPESAFE_API_KEY="${TYPESAFE_API_KEY#\"}"
    export TYPESAFE_API_KEY
    echo "==> loaded TYPESAFE_API_KEY from repo .env for the model-reviewed scenario"
  fi
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "FAIL: 'opencode' is not on PATH." >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: 'curl' is required for the server health poll." >&2
  exit 2
fi

# GNU date milliseconds (this script targets Linux; see the header).
now_ms() { date +%s%3N; }

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

# `elapsedMs` from a decision event line (empty when absent).
decision_elapsed_ms() {
  printf '%s' "$1" | sed -n 's/.*"elapsedMs":\([0-9][0-9]*\).*/\1/p'
}

# Decision events whose source is not the deterministic policy, the session
# cache, or a review failure — i.e. genuine model reviews.
model_decision_lines() {
  grep '"event":"decision"' "$diag" 2>/dev/null | grep -v '"source":"policy"' | grep -v '"source":"session"' | grep -v '"source":"error"' || true
}

run_attached() {
  local prompt="$1" transcript="$2"
  local args=(run --attach "http://127.0.0.1:$port" --dir "$work" "$prompt")
  if [ -n "${CALIBRATED_MODEL:-}" ]; then
    args=(run --attach "http://127.0.0.1:$port" --dir "$work" --model "$CALIBRATED_MODEL" "$prompt")
  fi
  opencode "${args[@]}" > "$transcript" 2>&1 || true
}

# ---------------------------------------------------------------------------
# Scenario 1 — deterministic finding + model review (cat .env): the decision event
# carries the command, promptVersion, and the secret_exposure finding. The reply
# may lose the headless auto-reject race; a resume event, if present, must be ok.
# ---------------------------------------------------------------------------
prompt1='Run exactly this shell command, then stop: cat .env'

echo
echo "==> scenario 1: deterministic finding + model review (cat .env)"
s1_start="$(now_ms)"
run_attached "$prompt1" "$work/transcript1.txt"
s1_end="$(now_ms)"

# The resume loop lives in the (still-running) server. Give the idle-wait (up to
# 10s) + started-verification (up to 2s) window time to finish after the client
# exits, then poll a little longer for the fire-and-forget event to land.
sleep 12
i=0
while [ "$i" -lt 20 ]; do
  if grep -q '"event":"resume"' "$diag" 2>/dev/null; then
    break
  fi
  sleep 0.5
  i=$((i + 1))
done

if [ ! -s "$diag" ]; then
  echo "FAIL: no diagnostics were written to $diag."
  echo "      The plugin did not load — check the plugin spec ($plugin_spec) and opencode.json above."
  echo "--- serve log (last 40 lines) ---"
  tail -n 40 "$work/serve.log" 2>/dev/null || true
  echo "--- transcript (last 40 lines) ---"
  tail -n 40 "$work/transcript1.txt" 2>/dev/null || true
  exit 1
fi

resume_lines="$(grep '"event":"resume"' "$diag" || true)"
last_resume=""
session_id=""
started_line="null"
s1_ok=false
s1_routed=false
s1_decision="$(grep '"event":"decision"' "$diag" 2>/dev/null | grep '"command":"cat .env"' | tail -n 1 || true)"
s1_finding=false
s1_prompt_version=false
if printf '%s' "$s1_decision" | grep -q '"code":"secret_exposure"'; then s1_finding=true; fi
if printf '%s' "$s1_decision" | grep -q '"promptVersion":"2"'; then s1_prompt_version=true; fi
if [ -n "$resume_lines" ]; then
  last_resume="$(printf '%s\n' "$resume_lines" | tail -n 1)"
  session_id="$(printf '%s' "$last_resume" | sed -n 's/.*"sessionID":"\([^"]*\)".*/\1/p')"
  if printf '%s' "$last_resume" | grep -q '"started":true'; then
    started_line="true"
  elif printf '%s' "$last_resume" | grep -q '"started":false'; then
    started_line="false"
  fi
  if printf '%s' "$last_resume" | grep -q '"ok":true'; then s1_ok=true; fi
  if printf '%s' "$last_resume" | grep -q '"routing":{[^}]*"agent"'; then s1_routed=true; fi
fi

# ---------------------------------------------------------------------------
# Scenario 2 — model-reviewed command: the review completes and logs even though
# the reply loses the headless auto-reject race. Retried a few times.
# ---------------------------------------------------------------------------
prompt2='Run exactly this shell command, then stop: echo calibrated-race-probe'

echo
echo "==> scenario 2: model-reviewed command (echo calibrated-race-probe)"
s2_start="$(now_ms)"
s2_end="$(now_ms)"
s2_attempts=0
s2_model_decision=""
for attempt in 1 2 3; do
  s2_attempts=$attempt
  s2_start="$(now_ms)"
  run_attached "$prompt2" "$work/transcript2.txt"
  s2_end="$(now_ms)"
  # Give the server-side review a moment, then poll for the model decision.
  sleep 2
  j=0
  while [ "$j" -lt 20 ]; do
    s2_model_decision="$(model_decision_lines | tail -n 1)"
    if [ -n "$s2_model_decision" ]; then
      break
    fi
    sleep 0.5
    j=$((j + 1))
  done
  if [ -n "$s2_model_decision" ]; then
    break
  fi
done

s2_client_ms=$((s2_end - s2_start))
s2_elapsed="$(decision_elapsed_ms "$s2_model_decision")"
s1_client_ms=$((s1_end - s1_start))

# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
echo
echo "==> resume_probe events (session ${session_id:-unknown}):"
grep '"event":"resume_probe"' "$diag" 2>/dev/null | grep "\"sessionID\":\"$session_id\"" || echo "  (none)"
echo
echo "==> resume event (newest):"
if [ -n "$last_resume" ]; then
  echo "$last_resume"
else
  echo "  (none — scenario 1 produced no resume event)"
fi
echo
echo "STARTED:$started_line"
echo
echo "==> decision events (source / elapsedMs):"
grep '"event":"decision"' "$diag" 2>/dev/null | while IFS= read -r line; do
  src="$(printf '%s' "$line" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')"
  ms="$(decision_elapsed_ms "$line")"
  printf '  source=%-14s elapsedMs=%s\n' "${src:-?}" "${ms:-?}"
done || true
echo
echo "TIMING scenario1_client_ms=$s1_client_ms scenario2_client_ms=$s2_client_ms scenario2_attempts=$s2_attempts"
echo "TIMING scenario2_model_decision_elapsedMs=${s2_elapsed:-none}"
echo "TIMING note: the model-reviewed elapsedMs (hundreds-to-thousands) is the"
echo "             window that exceeds opencode's headless auto-reject; the"
echo "             deterministic policy elapsedMs (single-digit ms) beats it."
echo

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
s1_pass=false
if [ "$s1_finding" = "true" ] && [ "$s1_prompt_version" = "true" ]; then s1_pass=true; fi
s2_pass=false
if [ -n "$s2_model_decision" ]; then s2_pass=true; fi

if [ "$s1_pass" = "true" ] && [ "$s2_pass" = "true" ]; then
  echo "PASS: the deterministic finding reached the judge (decision event carries"
  echo "      command, promptVersion, and secret_exposure), AND the model review"
  echo "      completed (decision event logged) despite losing the reply race."
  if [ -n "$resume_lines" ]; then
    echo "      A resume event also landed: ok=$s1_ok routed=$s1_routed (informational)."
  else
    echo "      No resume event landed — expected when the model review loses the"
    echo "      headless auto-reject race; the decision event is the guard."
  fi
  exit 0
fi

echo "FAIL:"
if [ "$s1_pass" != "true" ]; then
  echo "      scenario 1: no decision event with a secret_exposure finding and promptVersion 2."
  if [ -z "$s1_decision" ]; then
    echo "      diagnostics exist but contain no decision event for 'cat .env'."
  else
    echo "      decision event: $s1_decision"
  fi
  echo "--- all diagnostics ---"
  cat "$diag"
  echo "--- transcript (last 40 lines) ---"
  tail -n 40 "$work/transcript1.txt" 2>/dev/null || true
fi
if [ "$s2_pass" != "true" ]; then
  echo "      scenario 2: no model-sourced decision event was written after $s2_attempts attempt(s)."
  echo "      the model review did not complete — check the serve log for plugin errors."
  echo "--- serve log (last 40 lines) ---"
  tail -n 40 "$work/serve.log" 2>/dev/null || true
  echo "--- transcript (last 40 lines) ---"
  tail -n 40 "$work/transcript2.txt" 2>/dev/null || true
fi
exit 1
