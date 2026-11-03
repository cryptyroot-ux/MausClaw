# Native engine-task evals

Offline, self-checking tasks for the MausClaw **native engine**. Each task
seeds a small workspace and ships an automatic checker plus a known-good
solution — no human or model judgment, no external CLI, and no live model call
by default.

## Run

    pnpm eval:engine            # offline checker mode: zero provider requests
    pnpm eval:engine --live     # not supported by this runner directly; set
                                # MAUSCLAW_EVAL_LIVE_INSTANCE (inline JSON) or
                                # MAUSCLAW_EVAL_LIVE_CONFIG (path to JSON) for a
                                # live, opt-in, owner-approved model run.

Checker mode (the default) never constructs a provider and sends zero HTTP
requests. For every task it asserts: the seeded workspace fails its checker,
and applying the known-good solution makes the checker pass.

Reports are written to `evals/results/engine-checkers-<timestamp>.json`
(gitignored). This committed baseline manifest lives at
`evals/engine-tasks/baselines/phase0.json`.

## Task set

15 tasks, 5 `basic` and 10 `hard`, in this fixed order:

fix-function, bug-from-log, rename-symbol, create-file, csv-transform,
multi-refactor, failing-test, apply-diff, long-context, parallel-reads,
web-lookup, skill-use, async-bug, cli-flag, ini-to-json

## Policies (Phase 0)

- Offline by default. `pnpm eval:engine` runs zero provider requests.
- Live mode requires `MAUSCLAW_EVAL_LIVE_INSTANCE` or
  `MAUSCLAW_EVAL_LIVE_CONFIG`; the runner refuses before any HTTP request when
  neither is set.
- No paid or live model run without separate explicit owner approval.
- No provider secrets or bearer tokens are written to reports; bodies are
  redacted and truncated.
- Every task gets a fresh temporary workspace under a temporary
  `MAUSCLAW_DATA_DIR`; cleanup runs in `finally` on success, failure, and
  abort.

## Related

- `evals/engine-tasks/tasks.ts` — the 15 task specs, seeds, checkers, solutions.
- `evals/engine-tasks/run-engine-tasks.ts` — isolated native-turn runner.
- `evals/README.md` — platform behavior evals (tiers 1-3).
