# Agent shared-state safety

## Mandatory operating rules

All implementation stays in the existing main checkout unless the user changes that constraint. Repository artifacts stay inside this repository. Skills and these instructions are procedural controls, not filesystem access enforcement.

1. Protect `.todos`, `.git`, database/WAL/SHM files, environments, historical evidence, and their ancestors from deletion, truncation, renaming, or replacement by workers. A prohibition on TD commands also covers direct filesystem mutation of TD storage.
2. Assign each worker an exact writable source/test list. Assign a separate, new evidence directory under `.review-artifacts/<ticket>/<unique-run-id>/`. Create it exclusively; an existing path is a collision, never permission to remove it. Do not put new evidence or environments inside `.todos`.
3. Do not perform recursive cleanup during setup, test teardown, or handoff. This includes shell commands, Python/Node filesystem APIs, finally blocks, and exit traps. Leave disposable artifacts for the orchestrator to inspect.
4. Cleanup requires a separate user-authorized scope and dry-run inventory. Reject protected paths, ancestors, symlinks, mount/subvolume boundaries, absent ownership records, and paths outside the exact disposable run. Do not compute deletion targets from `parents[]`, empty variables, wildcard matches, or fallback paths. Path validation does not eliminate races; stop concurrent writers before an approved deletion.
5. Keep one Git writer and serialize TD lifecycle writers. Implementers do not create TD sessions. QA receives a fresh isolated identity only after the committed task is `in_review`; QA closes PASS or returns FAIL, with readback by the orchestrator.
6. Treat every unexpected filesystem or tracker failure as a stop signal. A failed recursive removal may have already deleted its contents. Do not retry, initialize a replacement tracker, or describe it as an external failure without evidence.

## Mandatory delegation clause

Include this clause in every implementation and QA brief:

> You own only the listed source/test paths and a newly created unique evidence directory. No recursive cleanup or deletion, including through scripts, fixtures, traps, or filesystem APIs. Never delete, rename, truncate, or replace `.todos`, `.git`, shared evidence, environments, or any parent directory. If evidence setup collides, choose a new run ID. On unexpected missing shared state, stop and report; do not repair or initialize it. No branches/worktrees. Only the orchestrator stages and commits.

## Incident response

- Stop new task dispatch, source writers, commits, TD commands, and cleanup. Preserve terminal errors and exact command provenance outside the damaged root.
- Report what is observed versus inferred. Own delegated damage; do not attribute it to external activity without evidence.
- With read-only investigation authorization, inspect existing snapshots/backups and open deleted file descriptors. Keep holder processes alive; do not restart services or reboot while they may be the last recovery source.
- Request explicit authorization for an emergency preservation copy. Preserve into a new repository-local recovery directory, never directly over the tracker. Verify byte hashes and SQLite integrity on an isolated copy; account for WAL and compare latest known task/review identities. Integrity does not establish freshness or completeness.
- Restore only after separate approval, with writers stopped and the recovery source preserved. Never reconstruct approvals, evidence hashes, or runtime results from plausible summaries. Missing linked evidence remains missing even if the database is restored.

## Known incident and verification limits

A delegated evidence-setup cleanup targeted `.todos` and deleted its contents. Failure to remove the directory itself did not preserve its database or historical artifacts. A running process retained an open deleted SQLite descriptor; read-only in-memory inspection passed integrity checks. Preservation/restoration was not performed as part of writing this guide.

## Stronger controls still required

These are proposals, NOT installed protections:

- Enforce worker writable-path allowlists in the execution backend or OS sandbox; deny tracker and Git writes except through designated roles. Same-UID unsandboxed processes can bypass prose rules and helper checks.
- Use SQLite-aware, consistent backups with separately retained repository-local snapshots outside worker-writable paths. Verify restore drills, task/review freshness, and WAL handling; raw live DB copies are not a backup strategy.
- Keep evidence append-only with immutable hashes and independently protected retention. Separate disposable fixtures from tracker and review records.
- Test enforcement against shell deletion, Python/Node deletion, symlink/ancestor escapes, partial failures, and concurrent path replacement before calling the protection effective.

No GitHub Actions are to be added; document authorized automation in `docs/DEPLOYMENT_GUIDE.md`.
