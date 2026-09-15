# Atlas Identical-Payload Rebroadcast — Review Packet (revision 2)

## Scope

Review branch `fix/final-live-wiring` against production `main` at
`a8c74ed1fe5af987501ea9b9204d51d10bf03480`. Production remains V6b
`PAPER_ONLY`. This adds a state-changing RPC call only to the existing isolated
offline recovery command. The web runtime remains disconnected.

## Preconditions before network send

`ExecutionRebroadcastResolver.rebroadcastIdentical` requires:

- exact `REBROADCAST_ATLAS_IDENTICAL_SIGNED_PAYLOAD` operator assertion;
- a durable `signed`, `broadcast`, crash-left `rebroadcast-requested`, or
  receipt-timeout `manual-review` record;
- a string signed payload and valid stored transaction hash;
- `keccak256(signedPayload)` exactly equal to the stored hash;
- parseable signed bytes whose recovered signer is the configured wallet;
- parsed chain ID and nonce equal to the journal record;
- protocol-v3 intent digest recomputed from the signed bytes and wallet;
- signed target in the configured router allowlist;
- EIP-1559 type with gas and both fee fields inside the configured caps;
- exact pending nonce-lane ownership for intent, chain, wallet, and nonce;
- valid `latest` and `pending` account nonce reads, neither advanced beyond the
  journaled nonce.

If `latest > nonce`, the command records
`execution-nonce-consumed-without-receipt`. If only `pending > nonce`, it records
`execution-nonce-pending-conflict`. If either value is below the journaled nonce,
it records `execution-nonce-gap-below-journaled-nonce`. All remain
`manual-review`, retain the lane, and make no send call.

## Evidence-before-network ordering

When nonce reads are safe, the resolver first durably transitions to
`rebroadcast-requested`, recording the derived hash and observed nonces. Only
after the evidence append, fsync, and atomic state checkpoint succeed does it
call `eth_sendRawTransaction` with the unchanged journaled payload. A crash after
the call leaves a hash-bearing pending record that ordinary receipt recovery can
reconcile. A crash-left `rebroadcast-requested` record can retry only the same
hash-verified bytes.

The returned RPC hash must equal the derived/stored hash before the `broadcast`
checkpoint. The isolated command immediately runs the existing receipt
reconciler after a successful send. Only a validated mined receipt transitions
to `confirmed`/`reverted` and finalizes the nonce.
Top-level `safeToRestart` is the conjunction of the opening reconciliation and
post-send reconciliation, so a post-send RPC error cannot produce exit code 0.

## Command and safety boundary

- The target must have existed durably before the recovery run.
- The exclusive recovery lock covers initial receipt reconciliation, nonce
  reads, pre-send checkpoint, send, post-send checkpoint, receipt reconciliation,
  evidence append, and state persistence.
- Concurrent state/evidence writes fail persistence and prevent the send when
  detected before it.
- Signing and attestation private material remain forbidden.
- No signing, payload construction, replacement, cancellation, or nonce release
  exists in this path.
- `index.js` does not import the resolver or recovery command.
- Micro-mainnet remains disabled.

## Validation

- `npm run check`: passing
- `npm test`: 286/286 passing on the dependency-complete runner
- `git diff --check`: clean

Tests cover exact-byte send, evidence-before-send ordering, hash/chain/nonce/lane
drift, off-policy payload refusal, confirmed/pending/gap nonce conflicts, failed
checkpoint preventing send, crash-left retry, command-level raw payload equality,
post-send receipt recovery, and retention of the nonce until a mined receipt.

## Deliberate remaining blockers

1. Final live execution wiring and per-intent readiness rechecks.
2. End-to-end micro-mainnet dry run and final adversarial review.

## Reviewer questions

1. Can any bytes other than the durable journal payload reach the RPC?
2. Is the hash independently re-derived before every send?
3. Are signer, chain, nonce, and pending-lane ownership all exact?
4. Can a consumed or conflicting nonce be broadcast or released?
5. Is the send always preceded by a durable attempt checkpoint?
6. Does a crash at every checkpoint leave a recoverable, conservative state?
7. Can a mismatched RPC return hash be journaled as broadcast?
8. Can a nonce be finalized without a fully validated mined receipt?
9. Does the web runtime remain disconnected from this capability?

## Required verdicts

- Merge isolated identical rebroadcast: **GO / NO-GO**
- Deploy in `PAPER_ONLY`: **GO / NO-GO**
- Begin final live-path wiring: **GO / NO-GO**
- Enable micro-mainnet: expected **NO-GO** pending final wiring/review

Report correctness findings by severity with exact file/line references and the
smallest required correction. Separate optional hardening.
