# opencode-calibrated-access

OpenCode plugin that rates command safety via an alignment/impact risk matrix, with per-tool thresholds and auto-alternatives on rejection. Scoring is model-driven: the default backend is [TypeSafe AI](https://docs.typesafe.ai) System One (Jev and friends), with an OpenAI-compatible chat fallback for general LLMs.

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
        "riskThresholdBash": 0.4,
        "riskThresholdDirectory": 0.3
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

**1. Deterministic policy** — rules with no model involvement. Blocks catastrophic deletes (`rm -rf /`, `rm -rf ~`). Allows known-safe routine commands (`git status`, `npm test`, `cargo build`, `pytest`). Also blocks commands the user explicitly prohibited in their last message.

**2. Session approval cache** — if the user previously approved an exact action+pattern combination in this session, it's reused without re-review.

**3. Model review** — for everything else, a model judges the request on two dimensions. Set `provider` to `"typesafe"` (default; Jev-aligned System One models using the `/systemone` protocol) or `"openai-compatible"` (a chat-completions fallback for general LLMs — see the caveat above; scores are less calibrated):

| Dimension | Scale | What it measures |
|-----------|-------|------------------|
| Alignment | 0–4 (inverse) | How closely the action matches user intent. 0 = user explicitly requested, 4 = fully autonomous. |
| Impact | 0–4 | How severe the damage would be if the command goes wrong. 0 = negligible, 4 = catastrophic. |

Risk is computed as `(alignment / 4) × (impact / 4)`.

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
| `riskThresholdBash` | `0.4` | Max risk (0–1) before bash commands are denied. |
| `riskThresholdDirectory` | `0.3` | Max risk before `external_directory` requests are denied. |
| `sessionApprovals` | `true` | Whether to cache approved narrow patterns per session. |
| `contextMessageCount` | `3` | Recent user messages sent as `userContext` to the model. |
| `diagnosticsPath` | none | Optional path for JSONL decision log. |

## How the Confidence Gate Works

A command passes the threshold check only if **overall confidence ≥ 0.5** — otherwise it is denied regardless of risk score.

Alignment confidence drops to ~0 when there is **no user context** because the model cannot distinguish "user explicitly requested" from "fully autonomous" without evidence. This means **every autonomous (unprompted) command fails the confidence gate**, even safe ones like `ls`. This is by design:

- Commands the user explicitly asked for get alignment scores of 0–1 and alignment confidence ~0.84 → overall confidence ≥ 0.5 → gate passes.
- Commands the agent invents on its own get alignment confidence ~0 → overall confidence < 0.5 → gate blocks.

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
  matrix.ts      — computeRisk() + assessThreshold()
  policy.ts      — applyDeterministicPolicy() for hard rules
  cache.ts       — SessionApprovalCache for repeated approvals
  context.ts     — Normalize permission events, collect user messages
  diagnostics.ts — JSONL decision logging
  resume.ts      — Build continuation messages on denial
```

## Testing

```bash
bun test              # 128 tests (97 unit + 31 integration)
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