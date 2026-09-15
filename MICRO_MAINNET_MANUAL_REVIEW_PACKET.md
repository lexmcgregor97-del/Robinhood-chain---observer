# Atlas Micro-Mainnet Manual-Review Resolution — Review Packet

## Scope

Review branch `fix/micro-mainnet-manual-review`, based on accepted receipt
recovery revision 2 (`386f7ffa1a7fbc4bfa207ce1eaeb13a009803beb`). Production remains V6b
`PAPER_ONLY`. The change adds `execution-manual-review.js`, an isolated
`resolve-manual-execution.js` command, shared isolated-state plumbing, the final
`cancelled` journal status, tests, and runbook documentation.

## Inertness

The web runtime still imports no execution provider and exposes no submission
route or candidate-to-intent path. The operator command is not imported by the
runtime, rejects all signing and attestation private material, requires the web
service to be stopped, and uses the symmetric recovery lock. Nothing can sign,
replace, or construct a cancellation transaction.

## Resolution actions

### Unsigned reservation

`reject-unsigned` requires an exact intent-bound confirmation and accepts only
a `manual-review` record labelled `signed-transaction-not-durable` with neither
a transaction hash nor signed payload. It transitions to the new final
`cancelled` status, preserving any conservative spend charge, then releases the
nonce. `rejected` was deliberately not reused: the checkpoint invariant forbids
a rejected record from owning spend, while a nonce-reserved unsigned intent has
already durably reserved spend.

### Identical rebroadcast

`rebroadcast-identical` requires a second confirmation containing the intent ID
and transaction hash. It re-derives the hash from the durable signed payload,
calls `eth_sendRawTransaction` with those exact bytes, requires the returned
hash to match, and transitions back to non-final `broadcast`. It never signs,
changes fees, releases the nonce, or automatically retries.

### Proven nonce cancellation

`prove-nonce-cancel` requires a distinct replacement hash and confirmation. It
reads that transaction and receipt, requiring the configured Atlas sender,
exact reserved nonce, chain 4663, Atlas as recipient, zero value, empty calldata,
a matching mined receipt, and a valid block. Only this zero-value self-cancel
shape may resolve the original signed record to final `cancelled`; arbitrary
nonce-consuming transactions fail closed because their asset effects would
need separate accounting. This command only proves a cancel already mined; it
cannot create, sign, or submit one.

## Persistence and crash behavior

All actions use the same exclusive lock, state/evidence revalidation, global
execution serializer, evidence append + fsync, and atomic full-state checkpoint
as receipt recovery. Final journal persistence completes before nonce cleanup.
A crash between them leaves a `cancelled` record whose narrowly recognized
`operatorResolution` permits the next recovery run to finalize only that nonce
residue. A broadcast followed by journal-persist failure remains recoverable by
receipt lookup or another identical-byte attempt; it cannot be re-signed.

## Stale-lock runbook

The README now requires the operator to keep the service stopped, record the
lock's `pid`/`startedAt`, verify no recovery process is alive and state is quiet
for 60 seconds, then remove only that exact adjacent lock. Uncertainty remains
fail-closed.

## Tests

Tests cover wrong confirmations, unsigned records carrying signed identity,
exact-byte rebroadcast and returned-hash mismatch, valid mined self-cancel,
foreign sender, non-zero value, wrong nonce, non-empty calldata, crash-left
cancelled nonce residue, and real evidence/state round trips for all three
operator actions. Existing receipt recovery tests exercise the refactored
shared isolated-state boundary unchanged.

## Remaining blockers

1. Real-organization Turnkey behavioral matrix with the structured denial
   schema pinned.
2. Journaled exact-approval orchestration, including zero-first and residue
   cleanup.
3. Concrete per-intent policy, balance, spend, and post-buy sell preflight.
4. Reviewed epoch-migration tool.
5. Strategy-to-intent binding and a qualifying V6b cohort.

## Reviewer questions

1. Can an unsigned resolution discard or refund its already reserved spend?
2. Can the command rebroadcast anything except the exact persisted signed
   bytes, or release that nonce before a receipt/cancel proof?
3. Can an arbitrary same-nonce transaction masquerade as the safe self-cancel?
4. Are every confirmation, transition, and nonce release durable and
   intent-bound across crash windows?
5. Can any operator action be reached from the web runtime or sign a new
   transaction?

## Expected verdict

- Merge as inert operator-recovery tooling: reviewer decision.
- Deploy to production: not needed.
- Enable micro-mainnet: **NO-GO**.
