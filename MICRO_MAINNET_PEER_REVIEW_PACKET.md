# Atlas Micro-Mainnet Execution Boundary — Revision 3 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 3, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf` and compared with revision 2
`1fdabe80b5a4dfac6150669022b2222c97005074`. Production remains V6b
`PAPER_ONLY`. This branch remains inert and must not be treated as an execution
release.

This revision responds to findings N-1 through N-4 from the second independent
review. It changes only dormant execution scaffolding, status, tests, and docs.

## Safety claim

This revision cannot submit a transaction. It creates no POST endpoint and no
candidate-to-execution call. `submissionPathConnected` and
`automaticSubmissionEnabled` remain literal `false`; activation retains
`execution-submission-path-not-connected`. The signing private key is not loaded
by the web runtime.

## Changes since revision 2

1. **Wallet funding is the compromise bound (N-1).** Activation requires a
   verified WETH balance and fails with `wallet-balance-exceeds-daily-cap` when
   it exceeds `maxDailyWei`. A missing measurement fails separately. The docs
   now state the honest invariant: direct transfer-out is forbidden, but hostile
   swaps can lose the funded wallet balance. Just-in-time funding and a
   pre-intent balance recheck remain required when execution is connected.
2. **Dropped broadcasts are recoverable (N-2).** Operator-only identical-byte
   rebroadcast accepts both `signed` and `broadcast` journal states. Payload
   hashing, exact returned-hash matching, no re-signing, and no automatic
   rebroadcast remain unchanged.
3. **Approval slice semantics are pinned (N-3).** A regression test requires the
   exact selector slice and padded spender word. The real Turnkey behavioral
   matrix explicitly requires a positive allowlisted approval and a negative
   foreign-spender approval.
4. **Signed external verification attestation (N-4).** The one-shot command can
   issue a P-256-signed attestation with a maximum 24-hour lifetime, bound by a
   SHA-256 fingerprint to the complete public execution configuration and to
   distinct observer/signing user IDs. The runtime reads only the attestation
   public key, validates signature/expiry/configuration, and uses the observer
   Turnkey credential to revalidate the signing user and exact policy set
   hourly. No signing private key enters the web process.

## Turnkey policy and funding model

The expected applicable ALLOW set remains exactly buy swap, sell swap, and
approval. Buy and sell return assets to Atlas; approval permits only an
allowlisted router, while application validation binds the exact amount and
rejects `MAX_UINT`.

This blocks direct exfiltration but does not bound hostile-pool slippage. A
compromised signing credential can trade the wallet's WETH into an attacker pool
at a negligible minimum output. The economic loss bound is therefore the funded
wallet balance. Production execution must use just-in-time funding, keep WETH at
or below the daily cap, and re-read the balance immediately before each intent.

Exact policy-text matching remains fail-closed metadata validation, not proof of
Turnkey policy semantics. A real-organization behavioral signing matrix remains
mandatory before any execution decision.

## Deliberate remaining blockers

1. Run the real Turnkey behavioral matrix: valid buy, sell, and allowlisted
   exact-approval requests must succeed. Wrong chain, non-zero value, foreign
   router, wrong selector, excessive input, zero minimum output, three-token
   path, wrong WETH orientation, foreign recipient, excessive gas/fee, foreign
   approval spender, and `approve(MAX_UINT)` must be denied. Record sanitized
   activity IDs.
2. Persist and reconcile `ExecutionJournal`, `NonceLane`, and `SpendLedger` with
   the state/evidence checkpoint protocol. Activation's pending count is still
   deliberately supplied as zero because no runtime lifecycle exists.
3. Implement exact approval orchestration: allowance read, optional zero-first,
   exact approval, swap, post-swap allowance check, and zero cleanup on failure
   or residue. Each action must be its own journaled intent.
4. Add native-gas balance checks, enforce the WETH funding check immediately
   before every intent, add a post-buy sell re-probe, and complete the final
   strategy-to-intent binding.

## Reviewer questions

1. Does activation reject an unmeasured or over-cap WETH balance, and is the
   documentation honest about hostile-swap loss exposure?
2. Can identical-byte recovery handle both pre-broadcast and dropped-broadcast
   states without re-signing or automatic submission?
3. Is the signed attestation cryptographically bound to expiry, distinct users,
   and every public execution-policy input?
4. Can the observer credential safely revalidate the signing user's API-key
   ownership and exact policy set in the real Turnkey organization?
5. Does public status expose any private key or user ID? The non-public
   attestation necessarily binds both user IDs; confirm it is never served.
6. What persistence or behavioral evidence remains required before connecting
   the dormant provider?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure a signing key.
- Enable micro-mainnet: **NO-GO**.
