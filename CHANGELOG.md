# Changelog

## 0.1.0 — 2026-09-22

- Initial release.
- Three-gate permission model: deterministic policy → session cache → TypeSafe AI risk rating.
- Alignment/impact risk matrix with per-tool thresholds.
- Session approval cache for repeated narrow patterns.
- Confidence gate blocks autonomous (unprompted) commands.
- Deterministic policy blocks catastrophic deletes (`rm -rf /`, `rm -rf ~`), allows known-safe commands (`git status`, `npm test`, etc.).
- JSONL diagnostics logging.