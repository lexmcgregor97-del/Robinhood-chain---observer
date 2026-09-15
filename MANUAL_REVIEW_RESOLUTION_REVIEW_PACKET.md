# Atlas Never-Signed Manual-Review Resolution — Review Packet

## Exact scope

Review PR #22, branch `fix/manual-review-resolution`, against production
`main` at `386f7ffa1a7fbc4bfa207ce1eaeb13a009803beb`.

The implementation commit is
`4e96dfae50d14c013eeee11e6e8a39376c201677`. The final review commit is the
packet-only descendant linked in the handoff. Review that exact final commit,
not an implicitly moving branch.

Production and Railway remain unchanged in V6b `PAPER_ONLY`. This branch is
inert recovery scaffolding. It does not enable micro-mainnet execution.

## Change

The isolated recovery command can resolve one `manual-review` record as
`operator-rejected` only when all of the following are true:

1. The operator selects the exact intent with
   `EXECUTION_MANUAL_REVIEW_INTENT_ID`.
2. The operator supplies the exact
   `EXECUTION_MANUAL_REVIEW_CONFIRM=REJECT_ATLAS_NEVER_SIGNED_RESERVATION`
   assertion.
3. The durable record is already `manual-review`.
4. Its recovery failure is exactly `signed-transaction-not-durable`.
5. It contains neither a valid transaction hash nor any string-valued signed
   payload.

The journal transition to `operator-rejected` is appended, fsynced, and
checkpointed before nonce finalization. Conservative daily spend remains
reserved. If the process crashes after the final journal checkpoint but before
nonce finalization, ordinary recovery recognizes only the typed
`never-signed-rejection` resolution and safely removes that nonce residue.

## Safety boundary

- The command still requires the separate
  `RECONCILE_ATLAS_EXECUTIONS_OFFLINE` assertion.
- The existing exclusive recovery lock and state-age check remain in force.
- Runtime signing and attestation private material remain forbidden.
- The new resolver has no provider, signer, or broadcast dependency.
- Any record containing signed bytes or a transaction hash is refused.
- The web runtime does not import or expose the resolver.
- Submission remains disconnected; micro-mainnet remains disabled.

## State semantics

`operator-rejected` is a distinct terminal state rather than ordinary
`rejected`. Ordinary `rejected` means an intent failed before spend
reservation. `operator-rejected` preserves the already-recorded conservative
spend while closing a reservation independently proven never signed.

Both `ExecutionJournal.pending()` and execution checkpoint pending counts
treat the new state as terminal. The spend/journal invariant still rejects
ordinary `rejected` records with recorded spend.

## Validation

- `npm run check`: passing
- `npm test`: 259/259 passing
- `git diff --check`: clean

Tests cover exact assertion enforcement, wrong intent state, transaction-hash
and signed-payload refusal, wrong recovery reason, journal-before-nonce
ordering, failed checkpoint rollback, crash-left nonce cleanup, and the full
isolated-command evidence/state round trip.

## Deliberate remaining blockers

1. Dropped signed transactions still require a separate reviewed operator path:
   identical-payload rebroadcast or independently proven nonce consumption.
2. Run and independently review the real-organization Turnkey behavioral
   matrix and pin its structured policy-denial field/code.
3. Implement journaled exact-approval orchestration, including zero-first and
   residue cleanup.
4. Implement fresh per-intent policy, balance, daily-spend, and post-buy sell
   preflights.
5. Implement the reviewed epoch-migration tool.
6. Bind qualified strategy decisions to immutable intents and complete a
   qualifying V6b cohort.

## Reviewer questions

1. Can a signed, hashed, broadcast, or ambiguously persisted record be
   operator-rejected?
2. Is the never-signed proof strong enough for every lifecycle crash boundary?
3. Is the final journal/evidence/state checkpoint guaranteed before nonce
   release?
4. Does every failure preserve both the manual-review record and blocked nonce?
5. Is crash recovery limited to a correctly typed durable operator resolution?
6. Is `operator-rejected` handled consistently by journal, checkpoint,
   readiness, and conservative-spend invariants?
7. Can a wrong intent ID or malformed environment value resolve another record?
8. Can the isolated command race the web runtime?
9. Are `pendingExecutions` and `safeToRestart` accurate after resolution?
10. Does runtime execution remain impossible?

## Required verdicts

- Merge PR #22 as inert recovery scaffolding: **GO / NO-GO**
- Deploy in `PAPER_ONLY`: **GO / NO-GO**
- Enable micro-mainnet: expected **NO-GO**

Report findings by severity with exact file/line references, exploit or failure
sequence, and the smallest required correction. Separate correctness findings
from optional hardening.
