# Atlas — Correction Verification: Paired Lifecycle Recovery

## Scope

This correction addresses A-1 through A-5 from the review of `9c59595`. No live-worker, execution, signing, wallet, Turnkey, router, approval, nonce, spend, promotion, or V4 module changes.

## A-1 — lifecycle books now participate in recovery

The recovery open-position count now includes the completed v7 books, completed frequency books, lifecycle control books, and lifecycle candidate books. The count is produced by the strict `paperOpenPositionCount` helper.

When only a lifecycle book holds a position and the observer is desynchronized, `recoveryPaperCycleMode` now selects `exits-only`. The recovery cycle therefore reaches current lifecycle quotes, marks, signal assessment, frozen adverse boundaries, emergency/invalidated exits, adaptive trails, and the absolute hold.

The focused test pins the exact missing case: both completed cohorts empty, one lifecycle-control position open, unsynchronized state → `exits-only`.

## A-2 — legacy freeze violations block entries, not exits

The completed-epoch check now runs after the lifecycle exit stage. Its disposition is explicit:

- `manageLifecycleExits: true`
- `allowEntries: false`
- `blockReason: completed-paper-epoch-not-flat`

The reason is assigned to `persistence.automationBlockedReason` and both lifecycle automation error fields. The poll gate recognizes only this specific block as exit-manageable and forces subsequent cycles to `exits-only`; all other automation block reasons retain their previous full halt semantics. Measurement and entries return immediately after the exit stage until the stale legacy state is resolved.

Thus a legacy violation cannot start a new position and cannot interrupt management of an already-open lifecycle position. The stale legacy book remains an operator-resolution condition rather than being silently mutated by a frozen policy.

## A-3 — exact units and proceeds are authoritative

The partial quote caller no longer converts held and sold BigInt units to a floating-point ratio. It passes the exact partial `quantityUnits` directly into `paperExitQuote`. Human quantity is derived once from those exact units only for display-price calculation.

Partial-close audit evidence now explicitly records:

- `exitUnitsAndProceedsAuthoritative: true`
- `executionPriceDerivedForDisplay: true`

This states the accounting contract in the evidence itself: exact units and simulated proceeds drive the ledger; execution price is a derived display value.

## A-4 — evidence filename documented

The journal intentionally remains one existing hash chain at the v7-derived filename. Renaming or splitting it during activation would sever checkpoint continuity. Lifecycle evidence is distinguished by its cohort-prefixed record types and independently reconciled counts, not by the containing filename.

## A-5 — checkpoint restore status exposed

`lifecycleExperiment.checkpointRestore` now reports the control and candidate independently with:

- `restoredFromCheckpoint`
- `reason`: `restored`, `checkpoint-absent`, `version-mismatch`, or `checkpoint-invalid`
- `savedVersion`

This distinguishes a first run from a version reset before entries are unpaused.

## Additional failure-path coverage

- A rejected partial quote is tested after `recordLifecycleMark`: the mark remains, no partial trade exists, and a later monotonic mark succeeds.
- A complete candidate lifecycle—open, partial, final close—reconciles against its evidence prefix, and removal of the partial evidence record fails validation.
- The paused-deployment verification must confirm both paired books have zero open positions and zero trades, both checkpoint-restore statuses are understood, and `submissionPathConnected` remains `false`.

## Operational decision

Deploy only with `PAPER_ENTRIES_PAUSED=true`. After restore and status verification, unpausing is eligible for a separate explicit approval. No automatic promotion or live execution is enabled.

## Final review follow-up: B-1 and B-2

- Exit audit provenance now derives from actual observer synchronization. A legacy-freeze exits-only cycle while synchronized records `duringRecovery: false`; genuine desynchronization records `true`.
- Applying the legacy-freeze block uses `||=` through `applyCompletedEpochBlock`, so a pre-existing durability reason such as `evidence-journal-failed` cannot be overwritten.
- Focused tests pin both behaviours.

## Evidence journal note

The file may still be named `2026-09-16-paper-v7-sellability-gated.jsonl`. That is an archival container name, not an epoch claim. Its hash chain includes multiple record prefixes, and each paper ledger is reconciled against its own prefix.
