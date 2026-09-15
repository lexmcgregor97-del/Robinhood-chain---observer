# Atlas Micro-Mainnet Execution Boundary — Peer Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, based on production commit
`5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf`. Production remains V6b
`PAPER_ONLY`; this branch must not be deployed or merged as an execution release.

New code:

- `micro-mainnet-config.js`: two-part activation, separate credentials, router
  allowlist, hard WETH caps, and public redaction.
- `turnkey-signing-probe.js`: read-only verification of the dedicated signing
  API user and an exact Turnkey policy.
- `turnkey-execution-provider.js`: Turnkey/viem signing plus direct RPC nonce,
  gas, broadcast, and receipt reconciliation.
- `index.js`: public status and signing-policy probe only.

## Safety claim

This revision cannot submit a transaction. It creates no POST endpoint and no
candidate-to-execution call. `submissionPathConnected` and
`automaticSubmissionEnabled` are hard-coded false, and activation therefore
retains `execution-submission-path-not-connected` even with complete variables.
The existing read-only credential remains unchanged and must differ from the
future signing credential.

## Turnkey policy precondition

Upload the V2 router ABI as a Smart Contract Interface before creating the
policy. The verifier accepts one exact applicable ALLOW policy only. It binds:

- `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`
- the Atlas wallet account
- Robinhood Chain ID 4663
- zero native value
- the configured V2 router allowlist
- `swapExactTokensForTokens`
- `0 < amountIn <= MICRO_MAINNET_MAX_WETH_PER_TX_WEI`
- `amountOutMin > 0`
- exactly two path elements with WETH first
- Atlas as the output recipient

Any additional applicable ALLOW policy fails verification.

## Questions for the reviewer

1. Can any environment combination arm activation while mode or enablement is absent?
2. Can observer and signer credentials be the same or address different wallets/orgs?
3. Does exact policy matching reject root, broad, alternate, or additional ALLOW policies?
4. Does any secret or Turnkey public key appear in `/health` or `/api/paper`?
5. Does transaction construction bind chain, sender, router, calldata, nonce,
   value, gas, and gas price before signing?
6. Is the signed hash persisted by the existing lifecycle before broadcast, and
   can recovery ever rebroadcast?
7. What persistence changes are required before connecting the provider to the
   strategy loop?
8. Design the minimal safe exact-approval flow; unlimited approval must remain forbidden.
9. Confirm that the Turnkey Smart Contract Interface field names match the two
   deployed V2 router ABIs on Robinhood Chain.
10. Confirm live remains NO-GO until approval orchestration, execution-state
    checkpointing, balance/gas funding, post-buy sell re-probe, and a qualifying
    V6b cohort are complete.

## Expected verdict

- Merge as inert scaffolding: review decision.
- Deploy to production: not requested; unnecessary while the cohort runs.
- Enable micro-mainnet: **NO-GO**.
