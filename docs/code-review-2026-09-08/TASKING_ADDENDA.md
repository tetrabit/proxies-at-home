# Execution addenda to the code-review task map

The original TASKS.md/tasking-verification.json are creation-time snapshots of 179 leaf tasks, not the live tracker. Query TD for current status. The immutable review documents and their original verification hashes remain unchanged.

## T34 — td-602040

Parent epic: td-cc790c (provider request policy and private API boundaries).
Dependency: td-e657e4 (the original direct-Scryfall broker).
Finding lineage: S01.

Operation: anchor the next minimum dispatch interval after synchronous transport invocation rather than before invocation overhead. The combined server gate exposed a 99 ms interval despite the 100 ms policy. A deterministic regression advances the clock inside the first transport callback and requires the second dispatch to wait the full interval afterward. The policy assertion remains >=100 ms; it was not weakened to hide the failure.

Acceptance: deterministic broker regression and existing FIFO/cancellation/router integration tests pass with retry 0. Source/test changes remain scoped to the broker timing boundary. Final QA owns approval or send-back after in_review submission.

Evidence: `.todos/cr-execution/checkpoint-3/spacing-red.log`, `server.log` (original combined failure), and `server-green.log` (corrected combined gate).

This adds one execution-discovered leaf, bringing the program to 180 leaf tasks. The original task-generation helper/map represent the initial decomposition; do not rerun `--apply` to recreate or overwrite live task state. The supplemental logical-key/ID record is `.todos/cr-execution/supplemental-tasks.json`.
