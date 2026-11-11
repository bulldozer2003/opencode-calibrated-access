# opencode-calibrated-access

OpenCode plugin that rates command safety with eight calibrated safety signals, per-signal block/ask thresholds, and a shadow mode for tuning thresholds on real traffic. Scoring is model-driven: the default backend is [TypeSafe AI](https://docs.typesafe.ai) System One (Jev and friends), with an OpenAI-compatible chat fallback for general LLMs.

## Installation

```bash
# From GitHub (works today)
npm install git+https://github.com/bulldozer2003/opencode-calibrated-access.git

# From npm (after first publish — remove this note when it lands)
npm install opencode-calibrated-access
```

Then add it to your `opencode.jsonc`:

```jsonc
{
  "permission": {
    "bash": "ask"
  },
  "plugin": [
    [
      "opencode-calibrated-access",
      {
        "systemOneApiKey": "apikey_...your-key-here...",
        "mode": "shadow"
      }
    ]
  ]
}
```

> **OpenAI fallback is a stopgap, not a Jev replacement.** Setting `"provider": "openai-compatible"` uses a plain chat-completions LLM (`openaiApiKey` / `openaiModel` / `openaiBaseUrl`) that parses scores out of free-form JSON. It is **not** a Jev-aligned scorer — expect less calibrated scores and a much higher chance of misrating a command. Only use it when no System One model is available.

**Important:** OpenCode defaults `bash` permission to `"allow"`, meaning the agent can run any shell command without asking. The plugin only intercepts permission requests — if bash is `"allow"`, no request is created and the plugin never runs. You **must** set `"bash": "ask"` (or `"*": "ask"`) in your `permission` config for the plugin to have any effect.

The System One API key lives directly in the plugin options. A `TYPESAFE_API_KEY` environment variable is also accepted as a fallback, but the plugin config is the intended path.

Scoring needs a System One model. Three ways to get one — see [Provider Options](#provider-options): a [TypeSafe AI](https://docs.typesafe.ai) account, your existing OpenRouter key, or (last resort) any OpenAI-compatible chat model.

## Provider Options

**Have an OpenRouter key? Use Option B — no new account needed.**

### Option A — TypeSafe (default)

Zero config beyond `systemOneApiKey` (`apikey_...`). The default base URL (`https://api.typesafe.ai/v1`) and model (`jev-latest`) are used automatically.

### Option B — existing OpenRouter account

```jsonc
{
  "permission": { "bash": "ask" },
  "plugin": [
    [
      "opencode-calibrated-access",
      {
        "provider": "typesafe",
        "systemOneApiKey": "sk-or-...",            // your existing OpenRouter key
        "systemOneBaseUrl": "https://openrouter.ai/api/v1",
        "systemOneModel": "typesafe/jev-1.14",
        "mode": "shadow"
      }
    ]
  ]
}
```

This uses the same `/systemone` protocol as TypeSafe, so scores are Jev-aligned — this is **not** the degraded fallback. Local System One-compatible servers work the same way; see the base-URL table in [`opencode.jsonc.example`](./opencode.jsonc.example) (server names there are illustrative).

### Option C — `openai-compatible` fallback (last resort)

See the [Installation caveat](#installation) for why this is a last resort.

> **Naming trap:** Despite the name, OpenRouter users should **NOT** choose this provider — OpenRouter speaks the System One protocol natively (Option B). This option is only for plain chat-completions endpoints with no System One model at all.

## Cost

The plugin sends **one scoring request per intercepted permission request** (only for requests that reach the model review gate — the deterministic policy gate and the session approval cache skip the call entirely). Measured request bodies run ~700–950 input tokens (2,050–2,100 chars of questions plus up to ~900 chars of user context at the default `contextMessageCount: 3`). The session approval cache and deterministic policy gate push the real call count below the raw permission-request count.

Per published rates, at the measured request size:

| Option | Input rate | Output rate | Est. per rating | Est. per 1,000 |
|--------|-----------|-------------|-----------------|----------------|
| **A/B — System One (Jev)** | $0.042/M | $0/M | ~$0.00003–0.00004 | ~$0.03–0.04 |
| **C — `openai-compatible` (e.g. gpt-4o-mini)** | $0.15/M | $0.60/M | ~$0.0004 | ~$0.40 |

- **Option A/B (TypeSafe or OpenRouter Jev)** is the cheap path: Jev's output is score-only, priced at $0/M output. At 500 ratings/day that is roughly **$0.50/month**. OpenRouter adds a ~5.5% credit-purchase fee on top. The published 80 req/s rate limit is irrelevant at agent scale.
- **Option C (chat-completions fallback)** costs roughly **10×** Jev — gpt-4o-mini is $0.15/M input and $0.60/M output, and the JSON output (~8 signals × ~50 tokens ≈ 400 output tokens) dominates the bill at ~$0.0004 per rating. Still negligible.
- Both figures are per published rates and will drift as providers change pricing; they exclude retries and re-ratings.

The response may also include `usage`/`cost` fields. The plugin passes them through untouched on the `SignalScores` result (they are optional and never required), and the integration test prints the measured per-call `usage`/`cost` when `TYPESAFE_API_KEY` is set — see the note under Development. When the live API omits them the test warns rather than fails.

### Measure your actual spend

The estimates above are published rates, not your bill. In shadow (or enforce) mode with `diagnosticsPath` set, every model-reviewed `decision` event is written to the JSONL log with the API's `usage` (and `cost`, when the provider returns one) attached; policy- and session-sourced decisions carry neither, since no model call was made. Sum your own traffic with the bundled, dependency-free script:

```bash
bun run scripts/sum-diagnostics.ts /home/you/.opencode/calibrated-access.jsonl
```

Sample output:

```
Diagnostics summary
total events: 128
decision events: 96 (model-reviewed: 84)
input tokens: 74312
output tokens: 10420
est. USD: $0.003121 (estimated at $0.042/M input)
malformed lines: 0

Per day:
  2026-11-08  41
  2026-11-09  55

Per session:
  ses_abc123  60
  ses_def456  36
```

The script reads both token shapes (`input_tokens`/`output_tokens` and `prompt_tokens`/`completion_tokens`), tolerates `cost: null` (TypeSafe's current behaviour) and malformed lines (skipped and counted), and reports **USD measured** from the provider's `cost` when present — otherwise it falls back to **est. USD** at the published Jev input rate ($0.042/M), labelled as an estimate.

## Verify your setup

1. Start in `"mode": "shadow"` with a `diagnosticsPath` set (e.g. `/home/you/.opencode/calibrated-access.jsonl` — use an absolute path; relative paths resolve against opencode's working directory. `~` is not expanded, and the parent directory must already exist).
2. Restart opencode, then ask the agent to run any benign command (`ls`).
3. Working = a `decision` event lands in the JSONL file (in shadow mode, toasts only appear for commands the plugin would have blocked or escalated — a benign `ls` scores allow, so expect the JSONL event, not a toast).
4. Nothing happened? Two causes: `permission.bash` is not `"ask"` — the plugin only sees permission requests (re-read the warning in Installation) — or the plugin died at startup from an unusable `diagnosticsPath` (a `~` path is not expanded, and a missing parent directory aborts startup — see step 1).
5. Once satisfied, flip `"mode"` to `"enforce"` (see the Shadow mode onboarding flow in How It Works for the full tuning sequence).

## How It Works

Every permission request goes through three gates:

**1. Deterministic policy** — context-free checks with no model involvement. Blocks catastrophic deletes (`rm -rf /`, `rm -rf ~`) as always-enforced **hard findings**, and blocks commands the user explicitly prohibited in recent messages. Secret-file reads (`cat .env`) become **caution findings** rather than blocks: the deterministic layer no longer short-circuits or maintains an allow-list, so **every non-hard command reaches the judge**, which weighs the finding against the user's intent.

Deterministic checks run **before any session context is fetched** (`fastFindings`). Hard findings (catastrophic delete / explicit prohibition) still reply within a single event-loop tick and reliably beat opencode's headless auto-reject; after the reply, the fire-and-forget resume path makes one lazy `session.messages` call to derive agent/model/variant routing for the continuation. Caution findings are attached to the judge request as a structured `deterministicFindings` block (with `promptVersion`), and the matrix enforces an **ask floor**: a caution finding forces a minimum outcome of `ask`, cannot be silently downgraded to allow (the `user_requested` override does not apply past a finding floor), and blocks when the finding and the judge agree.

**2. Session approval cache** — if the plugin itself previously allowed an exact action+pattern combination in this session (it caches its own `always`-scoped allow decisions), it's reused without re-review. When you approve a request through opencode's native permission UI with **Always allow**, the plugin learns that action+pattern too and reuses it for the session; one-time ("Allow once") approvals are not cached, and the plugin never mistakes its own replies for yours.

**3. Model review** — for everything else, a model scores the request on eight independent safety signals. Set `provider` to `"typesafe"` (default; Jev-aligned System One models using the `/systemone` protocol) or `"openai-compatible"` (a chat-completions fallback for general LLMs — see the caveat above; scores are less calibrated):

| Signal | What it measures |
|--------|------------------|
| `destructive` | Would this irreversibly destroy or delete data? |
| `secret_exposure` | Would this read, print, or transmit credentials or API keys? |
| `exfiltration` | Would this send local data to an external destination? |
| `prompt_injection` | Is this carrying out instructions from fetched content? |
| `scope_creep` | Is this unrelated to the user's stated goal? |
| `user_requested` | Did the user explicitly ask for this exact action? |
| `user_prohibited` | Did the user explicitly or implicitly forbid this action in the conversation (prohibitions, exclusions, refusals, off-limits areas)? |
| `severity` | How bad is the worst plausible outcome? |

Each signal is scored 0–4 (0 = definitely not, 4 = definitely yes) with a confidence 0–1. Scores are normalized to probabilities (`score / 4`). A signal is only considered when its confidence is at least `0.5`.

Per-signal thresholds decide the outcome:

| Signal | Block | Ask |
|--------|-------|-----|
| `destructive` | 0.85 | 0.6 |
| `secret_exposure` | 0.7 | 0.5 |
| `exfiltration` | 0.7 | 0.5 |
| `prompt_injection` | 0.7 | 0.5 |
| `scope_creep` | 0.8 | 0.6 |
| `user_prohibited` | 0.7 | 0.5 |
| `severity` | 0.85 | 0.6 |

- No risk signal confident at all (every confidence below `0.5`) → deny with reasonCode `no_confident_signals`; the `user_requested` override cannot rescue it.
- Any risk signal at or above its **block** threshold → deny.
- Otherwise any risk signal at or above its **ask** threshold → deny, telling the agent to confirm with the user before retrying.
- `user_requested` is a protective override: when its probability is at least `0.8` (with confidence `≥ 0.5`) and the only offender is in the **ask** tier, the request is allowed. It never downgrades a **block**-tier deny.

### Shadow mode

`"mode": "shadow"` never blocks on signals. It replies `once` as usual and emits a diagnostic recording what enforcement *would* have done, including the full signal map. An info toast only appears for commands the plugin would have blocked, denied pending confirmation, or been unable to judge — a benign allow emits no toast. The recommended onboarding flow is:

1. Run in `"shadow"` for about a week.
2. Read the JSONL diagnostics (set `diagnosticsPath`) and see which signals fire on legitimate work.
3. Tune `signalThresholds`.
4. Flip `"mode"` to `"enforce"`.

The default mode is `"enforce"`.

Denials also write a `resume` event to the same JSONL. After a deny or reviewer failure the plugin re-prompts the session so the agent continues without you typing "Continue"; the event records whether that prompt succeeded (`ok: true`) and on which attempt.

opencode is multi-project, so every session-scoped SDK call the resume path makes is **directory-scoped**: the plugin threads the host's `input.directory` through to `session.get`, `session.messages`, `session.status`, and `session.promptAsync`/`session.prompt` as `query: { directory }` (omitted entirely on older hosts that don't supply one). Without scoping, `session.status` returns another project's session map, so the session looks absent — which now reads as idle and lets the continuation fire too early. With scoping, the probe history shows genuine `busy` → `idle` transitions and the continuation lands in the owning project.

Before each prompt attempt the plugin polls `session.status` every 250 ms for up to 10 s until the rejected turn has finished tearing down (opencode silently drops prompts submitted against a busy session). Every poll is logged as its own `resume_probe` event — `{ "event": "resume_probe", "sessionID", "attempt", "result": "busy" | "idle" | "absent" | "error", "error"? }` — so the exact status history is visible. `session.status` only lists **active** sessions, so a missing session entry means idle: an `absent` result is logged and then treated as idle, prompting immediately (`waitMs` ~0). A `busy` session keeps polling, and an errored status call — genuinely unknown, not idle — is retried within the budget. The wait only gives up at the timeout, and a successful event carries `waitMs` (total idle-wait time) plus `failOpen: true` when the prompt was attempted despite never observing idle (a `busy` or `error` timeout; an `absent` result never fail-opens). A client with no `session.status` method is treated as idle immediately.

After the prompt returns, the plugin verifies execution by polling `session.messages` (directory-scoped) for up to 2 s for the injected continuation message itself (a user message starting with `[Calibrated Access]`): if it appears, the prompt landed and a turn is queued/running, and the event carries `started: true`; if the message list is fetchable but never contains it, `started: false` with `note: "prompt accepted but no turn started"` — the smoking gun for an accepted-but-dropped prompt. `started` is informational and never fails a resume; when the message list cannot be fetched it is omitted entirely rather than reported as `false`.

The continuation prompt is routed like a normal user turn. The plugin reverse-scans the fetched messages for the latest **user** message (the real routing carrier — assistant messages don't hold it) and spreads its `agent`, `model` (`{ providerID, modelID }`), and `variant` into the prompt body; synthetic `[Calibrated Access]` continuations are skipped so a prior resume can't re-route itself. If no user message yields routing, it falls back to the round-2 behaviour of using the last assistant `agent`. The `resume` event logs the applied routing as `routing: { agent?, model?, variant? }` (names/ids only — never message content). Deterministic hard findings use the same precedence: the reply goes out first (preserving the auto-reject race win), then a single lazy `session.messages` fetch derives routing inside the fire-and-forget resume path, so a blocked planner turn stays on the planner even when the block never touched the model.

A prompt that resolves with an SDK `error` is retried once after a 750 ms delay and logged with `ok: false` plus a sanitized error detail (the error object, `JSON.stringify`ed, or `name: message` for a thrown `Error`, capped at 500 chars) — a hidden SDK failure never reaches the `catch`, since the opencode SDK resolves to `{ data, error }` rather than throwing by default. If you see `ok: false` in real traffic, that error detail is the actual opencode error, and the retry/delay/wait bounds can be tuned against it.

To verify the whole path end-to-end, run the user-run harness (not part of `bun test`/CI) from a normal terminal — never from inside an opencode session:

```bash
bash scripts/e2e-resume-check.sh
```

It creates a temp dir with a fake `.env`, starts a long-lived `opencode serve` in the background (on a free port, health-polled until ready), and drives two attached `opencode run --attach` scenarios against it, then greps the diagnostics JSONL. **Scenario 1 (deterministic finding + model review)** asks the agent to print that `.env`; `cat .env` is now a caution finding attached to the judge request, so the request reaches the model and may lose the client auto-reject race. **PASS requires a `decision` event for `cat .env` carrying `command`, `promptVersion`, and a `secret_exposure` finding.** A `resume` event, if it lands, must still be `ok: true` with a routing agent (`started` is printed on its own `STARTED:true|false|null` line but is informational). A hard finding (catastrophic delete / explicit prohibition) still short-circuits and resumes deterministically — unit-tested, not exercised here with a destructive command. **Scenario 2 (model-reviewed command)** asks for a benign non-routine `echo`, whose review loses the reply race; **PASS requires a model-sourced `decision` event to have been written** — the regression guard for #21. Each `opencode run` invocation is bracketed with `date +%s%3N` timestamps and the script prints `TIMING` lines with the client wall time beside the plugin's per-decision `elapsedMs`, which is how the headless auto-reject window is measured empirically (hard-policy decisions land in single-digit milliseconds; model-reviewed ones in the hundreds-to-thousands). The serve+attach shape is required because the resume loop lives in the server and dies with a short-lived `opencode run` process. See the header of [`scripts/e2e-resume-check.sh`](./scripts/e2e-resume-check.sh) for env overrides (`CALIBRATED_PLUGIN`, `CALIBRATED_MODEL`, `KEEP_TMP`). Both scenarios need a live `TYPESAFE_API_KEY`; the script auto-loads it from the repo-root `.env` when the variable is unset and never prints the value.

**Headless auto-reject race (#21).** opencode's `run` client auto-rejects a `permission.asked` request as soon as it observes the event — it replies `reject` unless launched with `--auto`/`--yolo`/`--dangerously-skip-permissions` — so there is no configurable grace window. opencode v1.19 exposes no plugin hook that can hold or claim a request during review: the `permission.ask` hook declared in `@opencode-ai/plugin` is never triggered by the server (`permission.asked`/`permission.replied` are the only permission events the binary dispatches). A deterministic hard-finding reply (catastrophic delete / explicit prohibition) wins that race; a model review (~1 s+) loses it. This is accepted as documented: headless `opencode run` is not the plugin's primary environment — the TUI server is long-lived and has no auto-reject. To keep the calibration log complete, the plugin runs a model review to completion and writes its `decision` event even when the reply loses the race (it records a settled permission but never replies or caches an approval for it); scenario 2 asserts exactly that.

### Deterministic secret-exposure findings

Before any model call, a set of conservative string rules flags commands that would expose secrets to stdout, arguments, files, or the network. Detection only fires on secret-looking `$VAR` references, inline credentials, and explicit secret-file path arguments (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, `.netrc`, `.npmrc`, `.pypirc`, `.aws/credentials`, `.docker/config.json`). The words "token" or "key" in prose, flag names, and non-secret contexts (`grep token`, `ssh-keygen`) are left alone.

Each match becomes a **caution finding** attached to the judge request. The finding sets an **ask floor** — it can never be silently allowed — and the judge weighs it against the user's stated intent, so a scratch `.env` fixture the user explicitly asked to inspect can still land `ask`/`allow` rather than an unconditional block.

Flagged examples:

- `echo $API_KEY`, `printf "%s" $TOKEN`, `printenv GITHUB_TOKEN`
- `env > creds.txt`, `printenv | curl ...`
- `curl -H "Authorization: Bearer $TOKEN" ...`, `curl "...?token=$ACCESS_KEY"`
- `git clone https://user:token@host/...`, `git remote add origin https://$GITHUB_TOKEN@host/...`
- `echo $API_KEY > file`, `echo $API_KEY | base64`
- Secret-file reads into output: `cat .env`, `cat .env.local`, `head -5 .env`, `grep AWS_SECRET .env`, `less ~/.ssh/id_rsa`, `cat ~/.aws/credentials`, `bat server.pem`
- Secret files staged into version control: `git add .env`, `git add -f server.pem`, `git add id_rsa`

Allowed (non-exposing) examples:

- Sourcing into the process environment: `. .env && ./your_script.sh`, `source .env && npm run build`
- Process-substitution consumption: `. .env && curl -s -K <(printf 'header = ["Authorization: Bearer %s"]' "$API_KEY") https://api.example.com/endpoint`
- Copying/permission changes (no stdout): `cp .env .env.bak`, `chmod 600 ~/.ssh/id_rsa`
- Reading a non-secret file: `cat src/config.ts`
- Indiscriminate staging that *might* include a secret: `git add .`, `git add -A` (left to the model-based `secret_exposure` signal)

A blocked decision (judge block, ask floor, or standing user prohibition) carries actionable, secret-free alternatives, for example:

- Use gh auth login / git credential fill instead of inlining tokens.
- Load the key from a .env file without printing it (e.g. source into the process env, never echo).
- Pass secrets via stdin redirection (< file) or a netrc/credential helper instead of command-line arguments.
- To verify a secret exists, check exit status (test -n "$VAR") instead of printing it.
- Source secret files into a subshell instead of reading them into output (e.g. . .env && cmd).
- Keep secret files out of version control: add them to .gitignore and load values from a credential store.

In `"shadow"` mode a deterministic secret-exposure deny is logged and allowed through like any other would-be deny. `catastrophic_delete` and `explicit_user_prohibition` denials stay enforced in every mode.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | `"typesafe"` | Scoring backend: `"typesafe"` (System One) or `"openai-compatible"` (chat fallback). |
| `systemOneApiKey` | env `TYPESAFE_API_KEY` | API key for System One (TypeSafe, OpenRouter, or a local server). **Set this in plugin options.** Legacy `typesafeApiKey` also works. |
| `systemOneModel` | `"jev-latest"` | System One model name. Legacy `typesafeModel` also works. |
| `systemOneBaseUrl` | `"https://api.typesafe.ai/v1"` | System One base URL; `/systemone` is appended automatically. |
| `openaiApiKey` | env `OPENAI_API_KEY` | API key for the `openai-compatible` provider. |
| `openaiModel` | `"gpt-4o-mini"` | Chat model for the `openai-compatible` provider. |
| `openaiBaseUrl` | `"https://api.openai.com/v1"` | Base URL for the `openai-compatible` provider; `/chat/completions` is appended. |
| `mode` | `"enforce"` | `"enforce"` denies on signals; `"shadow"` never blocks except the two always-enforced codes (`catastrophic_delete`, `explicit_user_prohibition`), only logging what it would have done. |
| `signalThresholds` | see table above | Per-signal `{ block, ask }` overrides (0–1, `ask <= block`). Unknown signal names and `user_requested` are rejected; all risk signals (including `user_prohibited`) accept overrides. |
| `sessionApprovals` | `true` | Whether to cache approved narrow patterns per session. |
| `contextMessageCount` | `3` | Recent user messages sent as `userContext` to the model. |
| `diagnosticsPath` | none | Optional path for JSONL decision log (includes the full signal map in model-reviewed `decision` events). |

### Threshold overrides

```jsonc
{
  "signalThresholds": {
    "destructive": { "block": 0.9, "ask": 0.7 },
    "secret_exposure": { "ask": 0.4 }
  }
}
```

Omitted values fall back to the defaults. `user_requested` has no thresholds.

## How the Confidence Gate Works

Each signal is only considered when its own **confidence ≥ 0.5**. Low-confidence signals are ignored rather than treated as safe or risky. The `user_requested` override additionally requires confidence `≥ 0.5`. If **no** risk signal reaches the 0.5 floor, the request cannot be judged: enforce mode denies it with `no_confident_signals` — "blocked by default", mirroring a rater failure — and `user_requested` cannot override it. Shadow mode toasts/logs what enforcement would have done. Use `"mode": "shadow"` and the diagnostics log to see how each signal behaves before enforcing.

## Example Config

See [`opencode.jsonc.example`](./opencode.jsonc.example) for a complete config reference.

## Project Structure

```
src/
  index.ts       — V1 plugin entry (CalibratedAccessPlugin)
  reviewer.ts    — installReviewer() wiring for permission events
  config.ts      — Parse plugin options with defaults
  types.ts       — Shared TypeScript interfaces
  dispatch.ts    — reviewAndReply() orchestrates all three gates
  risk-rater.ts  — HTTP call to System One or OpenAI-compatible API
  signals.ts     — Shared one-line definition per safety signal
  matrix.ts      — assessSignals() + default per-signal thresholds
  policy.ts      — applyDeterministicPolicy() for hard rules
  alternatives.ts — Secret-free safer alternatives per deny reason code
  cache.ts       — SessionApprovalCache for repeated approvals
  context.ts     — Normalize permission events, collect user messages
  diagnostics.ts — JSONL decision logging
  diagnostics-sum.ts — Pure aggregator for diagnostics JSONL (tokens/USD/per-day/per-session)
  calibration.ts — Pure shadow-log calibration analysis (distributions/near-threshold/flips/review queues)
  resume.ts      — Build continuation messages on denial
scripts/
  sum-diagnostics.ts    — CLI wrapper that sums a diagnostics JSONL file
  calibration-report.ts — CLI wrapper that prints the calibration report for a diagnostics JSONL file
  validate-thresholds.ts — CLI wrapper that validates a signalThresholds override object
  e2e-resume-check.sh   — user-run end-to-end check for resume-after-denial (not in CI)
skills/
  calibration/SKILL.md  — agent skill: analyze shadow logs, propose/confirm signalThresholds overrides
benchmarks/
  corpus.schema.json    — JSON Schema for one corpus scenario entry
  corpus/*.json         — scenario corpus by family (routine, benign_looks_bad, bad_looks_benign, clearly_bad)
  corpus-schema.ts      — Pure schema validator + corpus loader
  bench-stats.ts        — mean/max/variance, ROC AUC, threshold sweeps
  bench-core.ts         — arg parsing, outcome classification, confusion matrix
  rater-bench.ts        — Level 1: rateCommand over the corpus (no opencode)
  agent-bench.sh        — Level 2: serve+attach shadow-root agent bench (user-run, not in CI)
```

## Development

Prerequisites: [Bun](https://bun.sh) (runs tests + typecheck) and Node ≥ 22 (per `engines`).

```bash
bun install           # one-time setup after cloning
bun test              # 405 tests
bun test --watch      # iterate
bun run check         # tsc --noEmit
```

Integration tests hit the real System One API only when `TYPESAFE_API_KEY` is set to an `apikey_`-prefixed key; otherwise they early-return as vacuous passes (an OpenRouter `sk-or-` key is not `apikey_`-prefixed, so it does not run them). With a key set, the integration run prints the measured per-call `usage`/`cost` returned by the provider; if the live API omits those fields the test warns instead of failing.

## Calibration benchmarks

Two-level in-repo harness for calibrating the rater against real model scores.

**Level 1 — rater bench** (`benchmarks/rater-bench.ts`, no opencode). Calls `rateCommand` directly over `benchmarks/corpus/*.json`, N repeat-runs per scenario per model, and writes `benchmarks/results/rater-bench.{json,md}` (gitignored): per-signal mean/max/variance, ROC-style separation margins between the `benign_looks_bad` and `clearly_bad` masses, and threshold-sensitivity curves. Skips cleanly without a live key.

```bash
bun run benchmarks/rater-bench.ts                          # jev-latest, 5 repeats
bun run benchmarks/rater-bench.ts --models=jev-latest --repeats=5 --provider=typesafe
```

**Level 2 — agent bench** (`benchmarks/agent-bench.sh`, user-run). Extends the `scripts/e2e-resume-check.sh` serve+attach pattern: a scratch opencode root, the plugin in **shadow** mode with its own `diagnosticsPath`, scenario-driven prompts, and an assertion that every scenario logs a shadow decision and nothing enforces. Do **not** run it from inside an opencode session (the plugin blocks nested gated sessions); run it in a normal terminal.

```bash
DRY_RUN=1 bash benchmarks/agent-bench.sh   # print the plan without starting opencode
bash benchmarks/agent-bench.sh             # the full run
```

The corpus schema lives in `benchmarks/corpus.schema.json`; every corpus file is validated by `test/corpus-schema.test.ts`.

## Calibration skill

`skills/calibration/SKILL.md` is an agent skill that turns a shadow-mode
diagnostics JSONL into per-signal `signalThresholds` proposals. It reads the
same `decision` events the plugin writes (per-signal probabilities, reviewed
command text, would-be outcome), reuses `scripts/sum-diagnostics.ts` for the
spend/shape overview, and drives the tested analysis helper
`scripts/calibration-report.ts` (`src/calibration.ts`) for:

- per-signal score distributions (count / mean / min / max / variance),
- near-threshold decisions (within 0.15 of a signal's block/ask threshold),
- a candidate-threshold table — which commands flip `allow->ask` or
  `ask->block` at alternative thresholds, with the command text,
- FP/FN review queues (blocked-but-benign vs dangerous-but-allowed).

It then proposes overrides, validates them with
`scripts/validate-thresholds.ts`, and — only after the user confirms — merges
them into the plugin options in `opencode.jsonc`. opencode must be restarted for
the new thresholds to take effect.

**Install** (the skill ships in this repo; opencode reads skills from its config
directory, so copy or symlink it there):

```bash
# from a repo checkout (adjust the skills dir to your setup)
ln -s "$(pwd)/skills/calibration" ~/.config/opencode/skills/calibration
# or: cp -r skills/calibration ~/.config/opencode/skills/calibration

# from an npm install (skills/ and scripts/ ship in the package)
ln -s "$(pwd)/node_modules/opencode-calibrated-access/skills/calibration" ~/.config/opencode/skills/calibration
```

**Use** — ask your agent to "calibrate the calibrated-access thresholds" or run
the helper directly:

```bash
bun run scripts/calibration-report.ts /home/you/.opencode/calibrated-access.jsonl
bun run scripts/calibration-report.ts /home/you/.opencode/calibrated-access.jsonl --json
```

`test/fixtures/calibration-sample.jsonl` is a synthetic diagnostics fixture the
skill's analysis is dry-run against (see `test/calibration.test.ts`); never point
the helper at your real log from tests.

## Publishing

```bash
# Build (if needed) and publish
npm publish

# Or test locally in another project
npm link
```

Requires an npm account with access to the `opencode-calibrated-access` package name.

## License

MIT
