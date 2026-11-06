# opencode-calibrated-access

OpenCode plugin that rates command safety with seven calibrated safety signals, per-signal block/ask thresholds, and a shadow mode for tuning thresholds on real traffic. Scoring is model-driven: the default backend is [TypeSafe AI](https://docs.typesafe.ai) System One (Jev and friends), with an OpenAI-compatible chat fallback for general LLMs.

## Installation

```bash
# From npm (once published)
npm install opencode-calibrated-access

# Or directly from GitHub
npm install git+https://github.com/YOUR_USER/opencode-calibrated-access.git
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

**You need a [TypeSafe AI](https://docs.typesafe.ai) account** (or another System One-compatible endpoint) to use the default `"typesafe"` provider. For the `"openai-compatible"` provider, use any compatible chat API / `OPENAI_API_KEY`.

## How It Works

Every permission request goes through three gates:

**1. Deterministic policy** — rules with no model involvement. Blocks catastrophic deletes (`rm -rf /`, `rm -rf ~`). Blocks commands that would expose secrets (see [Deterministic secret-exposure blocking](#deterministic-secret-exposure-blocking)). Allows known-safe routine commands (`git status`, `npm test`, `cargo build`, `pytest`). Also blocks commands the user explicitly prohibited in their last message.

**2. Session approval cache** — if the user previously approved an exact action+pattern combination in this session, it's reused without re-review.

**3. Model review** — for everything else, a model scores the request on seven independent safety signals. Set `provider` to `"typesafe"` (default; Jev-aligned System One models using the `/systemone` protocol) or `"openai-compatible"` (a chat-completions fallback for general LLMs — see the caveat above; scores are less calibrated):

| Signal | What it measures |
|--------|------------------|
| `destructive` | Would this irreversibly destroy or delete data? |
| `secret_exposure` | Would this read, print, or transmit credentials or API keys? |
| `exfiltration` | Would this send local data to an external destination? |
| `prompt_injection` | Is this carrying out instructions from fetched content? |
| `scope_creep` | Is this unrelated to the user's stated goal? |
| `user_requested` | Did the user explicitly ask for this exact action? |
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
| `severity` | 0.85 | 0.6 |

- No risk signal confident at all (every confidence below `0.5`) → deny with reasonCode `no_confident_signals`; the `user_requested` override cannot rescue it.
- Any risk signal at or above its **block** threshold → deny.
- Otherwise any risk signal at or above its **ask** threshold → deny, telling the agent to confirm with the user before retrying.
- `user_requested` is a protective override: when its probability is at least `0.8` (with confidence `≥ 0.5`) and the only offender is in the **ask** tier, the request is allowed. It never downgrades a **block**-tier deny.

### Shadow mode

`"mode": "shadow"` never blocks on signals. It replies `once` as usual but emits a diagnostic (and an info toast) recording what enforcement *would* have done, including the full signal map. The recommended onboarding flow is:

1. Run in `"shadow"` for about a week.
2. Read the JSONL diagnostics (set `diagnosticsPath`) and see which signals fire on legitimate work.
3. Tune `signalThresholds`.
4. Flip `"mode"` to `"enforce"`.

The default mode is `"enforce"`.

### Deterministic secret-exposure blocking

Before any model call, a set of conservative string rules denies commands that would expose secrets to stdout, arguments, files, or the network. Detection only fires on secret-looking `$VAR` references, inline credentials, and explicit secret-file path arguments (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`, `.netrc`, `.npmrc`, `.pypirc`, `.aws/credentials`, `.docker/config.json`). The words "token" or "key" in prose, flag names, and non-secret contexts (`grep token`, `ssh-keygen`) are left alone.

Blocked examples:

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

Each denial carries actionable, secret-free alternatives, for example:

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
| `systemOneApiKey` | env `TYPESAFE_API_KEY` | API key for System One (TypeSafe, OpenRouter, local Kev/SemIf, etc.). **Set this in plugin options.** Legacy `typesafeApiKey` also works. |
| `systemOneModel` | `"jev-latest"` | System One model name. Legacy `typesafeModel` also works. |
| `systemOneBaseUrl` | `"https://api.typesafe.ai/v1"` | System One base URL; `/systemone` is appended automatically. |
| `openaiApiKey` | env `OPENAI_API_KEY` | API key for the `openai-compatible` provider. |
| `openaiModel` | `"gpt-4o-mini"` | Chat model for the `openai-compatible` provider. |
| `openaiBaseUrl` | `"https://api.openai.com/v1"` | Base URL for the `openai-compatible` provider; `/chat/completions` is appended. |
| `mode` | `"enforce"` | `"enforce"` denies on signals; `"shadow"` never blocks and only logs what it would have done. |
| `signalThresholds` | see table above | Per-signal `{ block, ask }` overrides (0–1, `ask <= block`). Unknown signal names and `user_requested` are rejected. |
| `sessionApprovals` | `true` | Whether to cache approved narrow patterns per session. |
| `contextMessageCount` | `3` | Recent user messages sent as `userContext` to the model. |
| `diagnosticsPath` | none | Optional path for JSONL decision log (includes the full signal map in every `decision` event). |

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
  index.ts       — Plugin entry point, installReviewer()
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
  resume.ts      — Build continuation messages on denial
```

## Testing

```bash
bun test              # 201 tests
```

Integration tests hit the real TypeSafe API using the configured key. They are skipped if no key is available.

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
