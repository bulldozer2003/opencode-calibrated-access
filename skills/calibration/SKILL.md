---
name: calibration
version: 1.0.0
description: |
  Turn opencode-calibrated-access shadow-mode diagnostics into per-signal
  threshold changes. Use when asked to calibrate thresholds, run a threshold
  analysis, tune safety-signal calibration, review blocked commands, do an
  FP/FN review of the gate, or make sense of the plugin's diagnostics JSONL.
license: MIT
compatibility: any-agent
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# calibration

Analyze the `opencode-calibrated-access` plugin's shadow-mode diagnostics JSONL
and propose per-signal `signalThresholds` overrides for the user to confirm.
This skill drives the repo's tested analysis helper — it does **not** hand-read
the JSONL or invent thresholds.

## When this runs

The user wants to act on the shadow-mode log: "calibrate my thresholds",
"analyze the safety signals", "which commands got blocked and should not have",
"review the false positives / false negatives", "the gate is too noisy / too
loose". The plugin must have been running in `"mode": "shadow"` long enough to
accumulate `decision` events.

## Prerequisites

- The `opencode-calibrated-access` directory containing `src/calibration.ts`,
  `scripts/calibration-report.ts`, and `scripts/sum-diagnostics.ts` — either a
  repo checkout or the installed package
  (`node_modules/opencode-calibrated-access`). Run the helper commands below
  **from that directory**. If you are not already inside it and cannot find it,
  ask the user for the path rather than guessing.
- `bun` on `PATH`.
- The diagnostics JSONL path. Get it from the user, or from the plugin's
  `diagnosticsPath` option in the user's `opencode.jsonc`. If neither is
  available, ask.

Never copy, print, or commit the user's diagnostics file — read it in place.

## Workflow

1. **Locate inputs.** Resolve the plugin repo directory and the diagnostics
   JSONL path (ask if ambiguous). Confirm the file exists and is readable.

2. **Summarize spend/shape (reuse existing tooling).** Run:
   ```bash
   bun run scripts/sum-diagnostics.ts <diagnostics.jsonl>
   ```
   This gives total events, decision count, model-reviewed count, tokens, and
   estimated cost. Use it to state how much traffic the calibration is based on.

3. **Produce the calibration report.** Run the analysis helper:
   ```bash
   bun run scripts/calibration-report.ts <diagnostics.jsonl>
   ```
   Pass the user's current thresholds if they have customized them, so the
   report compares against reality rather than defaults:
   ```bash
   bun run scripts/calibration-report.ts <diagnostics.jsonl> \
     --thresholds '{"destructive":{"block":0.9,"ask":0.7}}'
   ```
   Add `--json` for machine-readable output; `--margin <0-1>` to change the
   near-threshold window (default 0.15).

   The report contains every deliverable:
   - **Per-signal score distribution** — count / mean / min / max / variance.
   - **Near-threshold decisions** — decisions within the margin of a signal's
     block/ask threshold, with the command text.
   - **Candidate threshold table** — per signal, which alternative threshold
     values flip commands `allow->ask` or `ask->block`, with the command text
     for each flip.
   - **Blocked-but-benign review** — ask/block decisions whose session later
     accepted a resume (`resume` with `ok: true`) or retried the same command.
   - **Dangerous-but-allowed review** — allow decisions followed, in the same
     session, by a later ask/block decision.

4. **Present the analysis to the user.** Show the per-signal distribution and
   the near-threshold list first, then the candidate table, then the two review
   lists with full command text. Do not summarize away the commands — the human
   needs them to judge.

5. **Propose overrides — with reasoning, and only as a proposal.** Derive each
   proposal from the table, not from intuition:
   - To cut **false positives** (blocked-but-benign commands near or above the
     threshold), propose **raising** that signal's `ask` and/or `block` to the
     next candidate value above the cluster, and name the commands it stops
     flagging.
   - To cut **false negatives** (dangerous-but-allowed commands near or below
     the threshold), propose **lowering** that signal's `ask` and/or `block` to
     the next candidate value below the cluster, and name the commands it starts
     flagging.
   - Leave signals with no near-threshold traffic and no review-queue entries
     alone. Changing a threshold with no evidence is churn.

   Present proposals as a concrete list, e.g.
   `secret_exposure.ask: 0.5 -> 0.4 (pulls "cat .env" at 0.45 into ask; 1 flip)`.
   State the trade-off (what newly flags / newly clears). **Ask the user to
   confirm each change.** Never write anything before an explicit yes.

6. **Validate before writing.** Build the proposed `signalThresholds` object and
   check it with:
   ```bash
   bun run scripts/validate-thresholds.ts '{"secret_exposure":{"ask":0.4}}'
   ```
   The helper rejects invalid values (ask > block, out of 0–1, unknown signals,
   the threshold-free `user_requested`) and prints the defaults-merged result.
   Fix any error and re-run until it prints `valid signalThresholds`.

7. **Write the confirmed overrides into `opencode.jsonc`.** Locate the user's
   config (project `./opencode.jsonc` or `~/.config/opencode/opencode.jsonc`).
   Find the `opencode-calibrated-access` plugin entry and merge the confirmed
   `signalThresholds` into its options object. Make the **smallest possible
   edit**: add only the signal/field keys being changed, preserve all comments
   and unrelated options, and do not reorder the file. If `signalThresholds`
   already exists, merge into it rather than replacing it. Re-run the
   validation helper against the final merged object to be sure.

8. **Report the outcome and the restart requirement.** Show the final
   `signalThresholds` block and tell the user: **opencode must be restarted for
   the new thresholds to take effect** — the plugin reads its options at load
   time. To verify, keep `"mode": "shadow"` for another session, re-run this
   skill, and confirm the near-threshold and review lists shrink.

## Limits (state these honestly)

- The follow-up evidence in the review lists is weak: a `resume` event is
  written for every denial, so "continued" is near-universal, and "dangerous"
  only means a later action in the same session was flagged. These are review
  queues, not verdicts — the human decides.
- `decision` events record per-signal probabilities and the reviewed command;
  they do not record the user's own approve/deny clicks.
- Policy-sourced decisions (`source: "policy"`, e.g. catastrophic deletes) are
  always enforced and are **not** threshold-tunable; leave them out of proposals.
- `user_requested` has no thresholds by design.
- Threshold changes only re-tune the model-signal gate; they never change the
  judge prompt or the deterministic findings.
