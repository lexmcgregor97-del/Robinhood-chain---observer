# Atlas Ambiguous-Signing Evidence Restoration — Review Packet (revision 2)

## Scope

Review branch `fix/ambiguous-signing-resolution` against production `main` at
`2c83b1a03550dbbf32356bd4192e902d3f9e4c75`. Production remains V6b
`PAPER_ONLY`. This is an inert verifier and journal-restoration primitive, not
an operator command or execution release.

## Change

`verifyAmbiguousSigningActivity` validates one completed Turnkey
`SIGN_TRANSACTION_V2` activity against a journal record already blocked as
`manual-review-signing-ambiguous`. It requires:

- protocol-v3 record, durable `signingRequestedAt`, intent-transaction digest,
  chain ID, and nonce;
- exact organization, signing-user approval vote, and signing wallet;
- activity creation within the bounded post-request window;
- parseable Turnkey unsigned intent and completed signed result;
- cryptographically recovered signer equal to the configured wallet;
- equality of chain, nonce, type, target, calldata, value, gas, and EIP-1559
  fee fields between unsigned and signed transactions;
- signed chain and nonce equal to the blocked journal record;
- a canonical digest of the signed transaction's chain, recovered sender,
  target, calldata, and value equal to the digest persisted before signing;
- EIP-1559 type and configured gas and fee ceilings.

The lifecycle now persists that canonical digest in the same fail-closed
`signing-requested` transition that precedes the Turnkey call. Because this
changes the marker's meaning, `SIGNING_PROTOCOL_VERSION` is bumped to 3;
protocol-v2 ambiguous records cannot use this restoration path. Safe
never-signed rejection remains available to both v2 and v3 records whose
durable evidence proves that signing was never requested.

The resolver performs verification internally from raw activity evidence; it
does not trust a caller-supplied `verified` flag. With the exact offline
assertion it journals the recovered hash, signed bytes, activity ID, and signed
time as `signed`, and clears the stale `recoveryFailure`. It does not finalize
the nonce or broadcast.

## Safety boundary

- No Turnkey client or private credential is accepted by this component.
- No activity listing or RPC call exists in this revision.
- No provider, signer, broadcaster, replacement, or cancellation path exists.
- The web runtime does not import these components.
- A failed or mismatched verification makes no journal or nonce mutation.
- Micro-mainnet remains disabled.

## Validation

- `npm run check`: passing
- `npm test`: 272/272 passing on the dependency-complete runner
- `git diff --check`: clean

Tests cover exact completed activity restoration, organization/status/time/
nonce/vote/wallet drift, unsigned-versus-signed intent mismatch, recovered
signer validation, canonical digest drift for a different genuine same-nonce
wallet transaction, gas/fee safeguards, refusal of unverified evidence, stale
recovery-label clearing, and retention of the pending nonce after restoration.

## Deliberate remaining blockers

1. Implement an isolated observer-key command that exhaustively lists the
   bounded activity window and refuses zero or multiple candidates.
2. Re-verify the selected activity by ID immediately before restoration.
3. Implement isolated identical-payload rebroadcast with receipt recovery.
4. Define independently proven nonce-consumption handling.
5. Complete the other existing micro-mainnet gates.

## Reviewer questions

1. Can raw caller data forge a verified result or restore arbitrary bytes?
2. Are organization, signing user, wallet, time, nonce, chain, signer, target,
   calldata, value, transaction type, gas, and fees all bound?
3. Can a failed/denied/pending activity restore a payload?
4. Can unsigned intent A be paired with signed transaction B?
5. Does successful restoration leave the nonce blocked and avoid broadcast?
6. Does the new code remain unreachable from the web runtime?
7. Can a different genuine wallet transaction sharing chain and nonce satisfy
   the persisted intent digest?

## Required verdicts

- Merge as inert evidence scaffolding: **GO / NO-GO**
- Deploy in `PAPER_ONLY`: **GO / NO-GO**
- Enable micro-mainnet: expected **NO-GO**

Report correctness findings by severity with exact file/line references and
the smallest required correction. Separate optional hardening.
