# Atlas Micro-Mainnet Execution Boundary — Revision 2 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 2, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf`. Production remains V6b
`PAPER_ONLY`. This branch remains inert and must not be treated as an execution
release.

This revision responds to findings M-1 through M-6 from the first independent
review. It changes only dormant execution scaffolding, status, tests, and docs.

## Safety claim

This revision cannot submit a transaction. It creates no POST endpoint and no
candidate-to-execution call. `submissionPathConnected` and
`automaticSubmissionEnabled` remain literal `false`; activation therefore
retains `execution-submission-path-not-connected` even with complete variables.
The signing private key is not loaded by the web runtime.

## Changes since revision 1

1. **Bidirectional swap policies.** The expected Turnkey set now contains an
   exact buy policy (`path[0] == WETH`) and sell policy (`path[1] == WETH`). Both
   require a two-token path, Atlas as recipient, an allowlisted router, positive
   minimum output, zero native value, and bounded gas fields.
2. **Approval policy.** A third exact ALLOW policy binds the ERC-20 `approve`
   selector and the spender to an allowlisted router. Application validation
   still requires the exact current-intent amount and rejects `MAX_UINT`.
3. **Exact set verification.** The signing user must be non-root, own the
   configured API key, and have exactly the three configured applicable ALLOW
   policies with exact expected text. Any additional applicable ALLOW fails.
4. **Bounded transaction fees.** The dormant provider constructs EIP-1559
   transactions and refuses estimated gas, priority fee, or maximum fee above
   the configured caps before signing.
5. **Recoverable signed bytes.** Before broadcast, the lifecycle persists the
   signed payload, transaction hash, and gas fields. Recovery escalates an old
   missing receipt to manual review. An operator-only method may rebroadcast
   only the identical stored bytes after rechecking their hash; recovery never
   rebroadcasts automatically and never re-signs an intent.
6. **One-shot signing verification.** `npm run verify:signing` is the only code
   that accepts `TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY`. It checks policy
   metadata and confirms the signing and observer credentials belong to
   different Turnkey users, prints sanitized output, and exits. The secret must
   not be configured in Railway.

## Turnkey policy model

The expected applicable ALLOW set is exactly:

- buy swap: WETH first, bounded WETH `amountIn`;
- sell swap: WETH last;
- approval: selector `0x095ea7b3`, spender in the router allowlist.

All three bind the configured Atlas wallet account, chain ID 4663, zero native
value, and configured EIP-1559 gas caps where applicable. Future policies must
preserve the containment invariant: swaps return assets to Atlas, approvals are
only for allowlisted routers, and there is no transfer or native-ETH-out
permission.

Exact policy-text matching is fail-closed metadata validation, not proof of
Turnkey policy semantics. A real-organization behavioral signing matrix remains
mandatory before any execution decision.

## Deliberate remaining blockers

1. Run the real Turnkey behavioral matrix: one valid request must succeed and
   wrong chain, non-zero value, foreign router, wrong selector, excessive input,
   zero minimum output, three-token path, wrong WETH orientation, foreign
   recipient, excessive gas/fee, and `approve(MAX_UINT)` must be denied. Record
   sanitized activity IDs for the review packet.
2. Persist and reconcile `ExecutionJournal`, `NonceLane`, and `SpendLedger` with
   the state/evidence checkpoint protocol. Activation's pending count is still
   deliberately supplied as zero because no runtime lifecycle exists.
3. Implement exact approval orchestration: allowance read, optional zero-first,
   exact approval, swap, post-swap allowance check, and zero cleanup on failure
   or residue. Each action must be its own journaled intent.
4. Add native-gas balance checks, a post-buy sell re-probe, and the final
   strategy-to-intent binding.

## Reviewer questions

1. Can any environment combination arm activation while mode, enablement,
   confirmation, policy verification, or submission-path connection is absent?
2. Does the verifier require exactly the buy, sell, and approval policies and
   reject every additional applicable ALLOW?
3. Do the buy and sell constraints cover both path orientations without
   permitting a foreign recipient or native value?
4. Can approval policy plus application validation authorize anything beyond
   the exact current-intent amount to an allowlisted router?
5. Are gas and EIP-1559 fees bounded before signing and journaled with the
   signed payload?
6. Can recovery re-sign, automatically rebroadcast, or broadcast bytes whose
   hash differs from the stored hash?
7. Is the signing private key absent from the web runtime and public status?
8. What additional persistence or policy behavior evidence is required before
   connecting the dormant provider?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure a signing key.
- Enable micro-mainnet: **NO-GO**.
