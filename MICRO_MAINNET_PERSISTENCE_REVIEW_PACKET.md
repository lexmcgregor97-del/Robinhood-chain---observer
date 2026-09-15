# Atlas Micro-Mainnet Durable Execution State — Review Packet (revision 2)

## Scope

Review branch `fix/micro-mainnet-persistence`, based on the accepted inert
execution boundary revision 7 (`36b2c71b9e8b834356bfcdacfc86ab4707ee7868`).
Production remains V6b `PAPER_ONLY`. This branch does not connect the dormant
provider, add a POST route, import a signer, or enable submission.

Revision 2 closes persistence-review finding P-1 from `aeb4da7`: reservation
evidence now precedes spend, and every execution persistence failure blocks the
live process immediately. It also documents the required future epoch
migration and makes the shared-serializer invariant explicit.

The change is limited to execution state durability, evidence reconciliation,
restore behavior, tests, the state writer, status, and documentation.

## Safety boundary

`submissionPathConnected` and `automaticSubmissionEnabled` remain literal
`false`. The web runtime still hard-fails if signing or attestation private
material is present. No candidate becomes an intent and no transaction can be
signed or broadcast.

## Changes

1. **All three execution components are checkpointed.** `ExecutionJournal`,
   `NonceLane`, and `DailySpendLedger` snapshots are stored under `execution` in
   the existing state file and restored before readiness. Journal transitions,
   nonce reservations/finalizations, and spend records each maintain a monotonic
   mutation counter.
2. **Every mutation is evidence-first.** Component persistence callbacks append
   `execution-transition`, `execution-nonce-reserved`,
   `execution-nonce-finalized`, or `execution-spend-recorded` to the existing
   hash-chained journal. `appendEvidence` then forces the complete state
   checkpoint. A callback failure restores the component's prior in-memory
   state. If evidence reached disk but state did not, the existing sequence/hash
   checkpoint blocks the next restore.
3. **Restore reconciles counts and ownership.** `validateExecutionCheckpoint`
   requires each mutation counter to equal its evidence type count. It rejects
   duplicate or orphaned intent IDs, spend entries without a non-rejected
   journal record, nonce reservations without a journal record, and signed or
   broadcast journal records without their durable nonce reservation.
4. **Pending activation is restored state.** `pendingExecutions` is computed from
   non-final records in the restored execution journal. It is no longer a
   literal zero. A final confirmed/reverted record with a nonce reservation left
   by a crash is finalized during restore and checkpointed before readiness.
5. **Reservation precedes spend.** The lifecycle durably journals `reserved`,
   then awaits the rollback-capable spend record, then reserves a nonce. A
   failed spend is finalized as a coded rejection when persistence is
   available; otherwise the durable reservation remains pending/manual-review.
   No orphan spend can exist without a journal record. UTC-day rollover returns
   an empty current-day view without erasing the historical mutation counter.
6. **Atomic state durability includes fsync.** The temporary state file is
   fsynced before rename and its directory is fsynced after rename.
7. **Mutation checkpoints are globally serialized.** Journal transitions, spend
   records, and nonce changes share one serializer across all components,
   intents, and lanes. An earlier evidence event therefore cannot accidentally
   checkpoint a later in-memory mutation that has not produced its own evidence.
   The production callback also sets `writeBlocked` and an automation-blocking
   reason on any execution persistence failure before it rethrows.

## Crash windows

- Journal reservation persistence fails: no spend or nonce mutation occurs and
  the live process is write-blocked.
- Journal reservation persists but spend persistence fails: the spend rolls
  back and the journal is finalized as a coded rejection. If that rejection
  cannot persist, the durable reservation remains pending/manual-review and the
  live process is write-blocked.
- Journal reservation and spend persist, crash before nonce reservation: the
  restored journal is pending and activation remains blocked.
- Nonce reservation persisted, crash before journal status advances: the nonce
  owner and journal owner match; the record remains pending/manual-review.
- Signed/broadcast state without a receipt: remains pending and blocks. Receipt
  reconciliation still belongs to the future isolated execution process.
- Final journal status persisted, crash before nonce finalization: restore
  finalizes the matching nonce reservation and writes evidence/state.
- Evidence append succeeds but state write fails: memory rolls back, while the
  sequence/hash divergence blocks restart. No silent divergence resumes.

## Epoch coupling

Execution mutation counts are reconciled against the same evidence journal as
paper. That gives one terminal hash and one checkpoint. It also means a paper
epoch must not be bumped while execution records exist unless a reviewed
migration carries or archives execution state and evidence together. With the
submission path disconnected, the current execution state is empty.

The required migration ceremony is: force `PAPER_ONLY`, stop new intents, and
require zero pending executions; archive the state file and matching evidence
journal with their terminal sequence/hash; run a reviewed migration tool that
verifies the pair and emits an execution-archive manifest; then begin the new
paper epoch with empty execution counters and a new evidence file. Hand edits
and evidence-file reuse are forbidden. Until that tool exists, non-empty
execution history prohibits an epoch bump.

## Tests

Tests cover:

- execution state round-trip through the real evidence journal and atomic state
  store;
- sequence/hash failure when evidence reaches disk but state does not;
- transition, nonce, and spend evidence-count mismatches;
- orphaned spend and nonce ownership;
- signed state without a nonce reservation;
- rollback on journal, nonce, and spend persistence failures;
- reservation-before-spend ordering, final rejection after a rolled-back spend,
  and pending/manual-review fallback when rejection cannot persist;
- concurrent journal, spend, and cross-wallet nonce mutations producing one
  monotonically complete snapshot per evidence event;
- UTC-day spend rollover and restored pending nonce blocking.

## Deliberate remaining blockers

1. Run and independently review the real-organization Turnkey behavioral matrix
   and pin the exact structured policy-denial field/code.
2. Add receipt-aware recovery in the isolated execution process before any
   readiness evaluation; unresolved or manual-review records must block.
3. Implement journaled exact-approval orchestration, including zero-first and
   residue cleanup.
4. Implement per-intent preflight reads for policy state, WETH/native balances,
   daily spend, and post-buy sell simulation.
5. Bind qualified strategy decisions to immutable intents and complete a
   qualifying V6b cohort.

## Reviewer questions

1. Can any component mutation reach a later side effect without its evidence and
   complete state checkpoint being durable?
2. Do all evidence-ahead and state-ahead crash windows fail closed?
3. Can restored spend or nonce ownership diverge from the journal undetected?
4. Can activation ignore a restored non-final execution record?
5. Is final-record nonce cleanup safe before provider recovery?
6. Does this branch remain incapable of transaction submission?

## Expected verdict

- Merge as inert durability scaffolding: reviewer decision.
- Deploy to production: not required for execution; safe only if migration of
  the existing empty execution state is confirmed.
- Enable micro-mainnet: **NO-GO**.
