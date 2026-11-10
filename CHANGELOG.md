# Changelog

## Unreleased

- Diagnostics `decision` events from a model review now carry the API's `usage`/`cost` fields (when present) alongside the signal map, turning the shadow-mode JSONL log into a spend ledger. Policy- and session-sourced decisions carry neither — no model call was made.
- New `scripts/sum-diagnostics.ts` (`bun run scripts/sum-diagnostics.ts <diagnostics.jsonl>`) plus pure aggregator `src/diagnostics-sum.ts`: totals decision events, model-reviewed count, input/output tokens, and USD — measured from the provider's `cost` when present, otherwise estimated at the published Jev input rate ($0.042/M) — with per-day and per-session breakdowns. Tolerates both token key shapes (`input_tokens`/`output_tokens` and `prompt_tokens`/`completion_tokens`), `cost: null`, and malformed lines (skipped and counted). Zero new dependencies.
- Docs: new README "Measure your actual spend" section with script usage and sample output; 257 tests (was 242).
- Capture optional `usage`/`cost` fields returned by the System One (`/systemone`) and chat-completions APIs and pass them through on `SignalScores` (`usage`/`cost`). Both are optional and never required — a live call is unaffected when the provider omits them.
- Integration test now prints the measured per-call `usage`/`cost` (soft-assert: warns if the live API returns none, never fails).
- Docs: README "Cost" section with per-rating and per-1,000 estimates for Options A/B (Jev) and C (gpt-4o-mini).

## 0.4.1 — 2026-11-10

- Fix: plugin failed to load in opencode v1.19 (`undefined is not an object (evaluating 'options.mode')`) — the entry point now uses the legacy `(input, options)` call shape and exports exactly one function, since opencode invokes every runtime export.
- Fix: events are consumed from opencode's hook-based delivery (`hooks.event`) through a local event registry, replacing the removed `data.on` bus; `dispose` unsubscribes and aborts in-flight reviews.
- Fix: `permission.asked` normalization accepts the 1.19 payload shape (`permission` → action, `patterns` → resources); v2 shapes untouched.
- Fix: `session.message.list` widened to async to match the 1.19 SDK.
- 237 tests (was 227).

## 0.4.0 — 2026-11-06

- New deterministic secret-exposure detection (`detectSecretExposure`): blocks commands that would print, redirect, or transmit secrets — `echo $API_KEY`, `printenv GITHUB_TOKEN`, `env > creds.txt`, `printenv | curl`, `curl` auth headers/queries with `$VAR` secrets, git URLs with inline credentials, and secret vars piped or redirected. Detection is conservative: prose words like "token", flag names, and non-secret contexts (`grep token`, `ssh-keygen`, `printenv PATH`, `env | grep TERM`) are not blocked.
- Extends secret-exposure detection to secret-bearing files: stdout read utilities (`cat`, `head`, `tail`, `less`, `more`, `bat`, `grep`, `rg`, `awk`, `sed`, `strings`) on secret-file paths (`cat .env`, `less ~/.ssh/id_rsa`, `bat server.pem`) and `git add` of an explicit secret-file path (`git add .env`, `git add -f server.pem`) are denied. Sourcing (`. .env && cmd`, `source .env`), process-substitution consumption (`curl -K <(printf ... "$API_KEY")`), `cp`/`chmod`, non-secret file reads, and indiscriminate staging (`git add .`, `git add -A`) stay allowed.
- Denials now carry actionable, secret-free `alternatives` (`src/alternatives.ts`), surfaced in both the rejection message and the agent continuation message under a `Safer alternatives:` heading.
- Shadow mode now also applies to deterministic denies: secret-exposure denies are logged and allowed through. `catastrophic_delete` and `explicit_user_prohibition` remain enforced in every mode.
- New `user_prohibited` safety signal — the eighth: "Did the user explicitly or implicitly forbid this action in the conversation (prohibitions, exclusions, refusals, off-limits areas)?" Mirror of `user_requested`: model-scored by both providers, default thresholds 0.7/0.5, overridable via `signalThresholds`. Extra prompt contexts flag version-control staging that could include secret files the user excluded (`git add .`, `git add -A`, `git commit -a`, `git stash -u`) and declared off-limits areas; blocks carry staging-specific safer alternatives (stage files individually after confirming none are secret-bearing; run `git status` first and add only the intended paths).
- Fix: `sessionApprovals: false` now disables the session-approval cache entirely (no reads or writes); previously it had no effect.
- Fix: broadened explicit user-prohibition phrase matching in the deterministic policy gate — the gate that blocks commands the user prohibited in recent messages, enforced in every mode, now recognizes more prohibition phrasings.
- Fix: wired `resumeAfterDenial` to the session continuation — denials and reviewer failures now pass a continuation message (deny reason plus safer alternatives) to the agent so it can recover with a lower-risk step instead of stalling.
- Docs: README secret-exposure section; 227 tests.
- Docs: working GitHub install instructions, new Provider Options section (TypeSafe / existing OpenRouter key / OpenAI-compatible last resort), Verify your setup steps, and Development quickstart with Bun prerequisites, and documented `user_prohibited` as the eighth signal across README, opencode.jsonc.example, and AGENTS.md.

## 0.3.0 — 2026-11-03

- **Breaking:** removed `riskThresholdBash` and `riskThresholdDirectory`. The 2-axis alignment/impact risk matrix is replaced by seven calibrated safety signals: `destructive`, `secret_exposure`, `exfiltration`, `prompt_injection`, `scope_creep`, `user_requested`, `severity`.
- New `signalThresholds` option: per-signal `{ block, ask }` thresholds (0–1), merged over defaults.
- `user_requested` is a protective override signal — a high-probability explicit user request downgrades an `ask`-tier deny to allow; it never downgrades a `block`-tier deny.
- Fail-closed: when no risk signal reaches the 0.5 confidence floor, enforce mode denies with `no_confident_signals` (mirrors rater-failure default); `user_requested` cannot override it. Shadow mode logs/toasts it.
- New `mode` option: `"enforce"` (default) denies on signals; `"shadow"` never blocks, replying `once` while logging what enforcement would have done.
- Diagnostics `decision` events now include `mode` and the full `signals` probability/confidence map.
- Both providers (`typesafe`, `openai-compatible`) now evaluate all seven signals in a single pass.
- 144 tests (119 unit + 25 integration).

## 0.2.0 — 2026-11-03

- Pluggable model providers: new `provider` option (`"typesafe"` (default) or `"openai-compatible"`).
- Configurable System One endpoint via `systemOneBaseUrl` (default `https://api.typesafe.ai/v1`); `/systemone` appended automatically — works with TypeSafe native, OpenRouter Jev, and local clones (Kev, SemIf, NanoJev, Von).
- New options: `systemOneApiKey`, `systemOneModel`, `openaiApiKey`, `openaiModel`, `openaiBaseUrl`.
- Backward compatible: legacy `typesafeModel` / `typesafeApiKey` alias to the new `systemOne*` options; blank strings are treated as absent.
- OpenAI-compatible chat fallback for general LLMs when no System One model is available (not Jev-aligned; scores are less calibrated).
- Security hardening: 15s fetch timeout, API key redaction in error messages, runtime response validation with score clamping, prompt injection hardening in the OpenAI path.
- 133 tests (102 unit + 31 integration).

## 0.1.0 — 2026-09-22

- Initial release.
- Three-gate permission model: deterministic policy → session cache → TypeSafe AI risk rating.
- Alignment/impact risk matrix with per-tool thresholds.
- Session approval cache for repeated narrow patterns.
- Confidence gate blocks autonomous (unprompted) commands.
- Deterministic policy blocks catastrophic deletes (`rm -rf /`, `rm -rf ~`), allows known-safe commands (`git status`, `npm test`, etc.).
- JSONL diagnostics logging.