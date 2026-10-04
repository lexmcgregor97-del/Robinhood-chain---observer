# Capped paper trial 2 — coverage review

Observed deployment: `b1ad4d579425ba33148737746492b7dd0e5589e0`.
Sources: observer `/health`, `/api/paper`, and the persisted `/api/evidence` journal.

## Result

- Started 2026-10-02 03:30:58 UTC; halted after approximately 30 minutes with
  `paper-trial-no-entry-progress`, after 3,891 RPC attempts. No new paper entries.
- 102 evaluation records: 34 in each of three cohorts, covering only two pools.
  These are repeated evaluations, not 102 distinct opportunities.
- 96 records had one swap in the minute; six had two. All failed activity and
  readiness gates. None qualified even when missing gas/sell evidence was excluded.
- Gas verification succeeded. No actual sell probe was attempted because the
  candidates already failed entry conditions. This does not establish sellability.
- First evaluation: 03:48:51 UTC; last: 03:56:49 UTC. Much of the trial was catch-up.
  The final stored scanner lag was 27 blocks; it is not a current live-chain lag.

## Confirmed coverage defects

1. The registry held exactly 5,000 pools. `registerPool` rejected every subsequent
   discovery at capacity, without a counter. Swaps for unregistered pools were
   silently ignored. The journal cannot quantify how much activity was missed.
2. Candidate selection took the top 25 across all pool versions and quote pairs
   before filtering to supported V2 direct-quote markets. Unsupported leaders could
   crowd supported candidates out of the measurement budget.

These defects invalidate a market-wide interpretation of the sparse sample. They
do not prove that a profitable or strategy-qualified trade was missed in this trial.

## Patch

- Rank supported V2 direct-quote pools before applying the existing measurement cap.
- Admit new factory discoveries by replacing the oldest dormant registry entry.
  Preserve at least 61 minutes of activity history (or the configured signal history,
  if longer), newly discovered pools, all paper positions, pending shadow samples,
  in-flight sell-probe candidates, and pools trading in the current scan range.
- Fetch the existing swap-log request before admission to protect pools returning
  to activity in the same range. No extra scanner RPC request is introduced.
- Persist coverage counters and expose them in `/health`: admissions, dormant
  evictions, protected-capacity rejections, tracked and untracked swap-log sightings.
  Sightings are not unique swaps: retrying a partially scanned range may recount them.
- Keep signal requirements, execution-cost limits, sell proofs, trial budgets and
  the disconnected live-execution boundary unchanged. A restarted halted trial
  remains halted unless an operator explicitly supplies a fresh trial ID.

## Validation and remaining limits

`npm test`: 530/530 passing, including a real offline observer subprocess restoring
5,000 dormant pools, admitting a factory discovery, and persisting the replacement.
Regression tests cover unsupported leaders, protected pools, warmup retention,
capacity refusal, and the existing durable restart/budget gates.

This is forward discovery, not a historical registry rebuild. Previously ignored
or evicted pools are not automatically reconstructed from swaps. The new untracked
log counter exposes that remaining coverage limitation without adding paid lookups.
V3 execution remains unsupported. A further capped paper trial is needed to measure
coverage and entry behavior; offline tests cannot establish trading performance.
