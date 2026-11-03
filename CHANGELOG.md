# Changelog

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