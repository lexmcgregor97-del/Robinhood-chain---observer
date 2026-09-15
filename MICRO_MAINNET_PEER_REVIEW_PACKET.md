# Atlas Micro-Mainnet Execution Boundary — Revision 5 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 5, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf` and compared with revision 4
`ca5faba11120a631e3dc8361536fce925ba49a5b`. Production remains V6b
`PAPER_ONLY`. This branch remains inert and is not an execution release.

Revision 5 responds only to B-1 through B-3. It changes the isolated verifier,
dormant lifecycle/journal, tests, and documentation.

## Safety boundary

No transaction can be submitted. There is no POST endpoint or
candidate-to-intent call; the provider and lifecycle are not imported by the
web runtime. `submissionPathConnected` and `automaticSubmissionEnabled` remain
literal `false`. No signing or attestation private material can coexist with
the web runtime.

## Changes since revision 4

1. **Turnkey outcomes, not strings, are attested (B-1).** The one-shot verifier
   calls `getActivity` for every matrix entry. Each success must be a completed
   `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` in the configured organization, for the
   configured wallet, with an approving vote from the independently identified
   signing user. The returned signed transaction must recover to Atlas, decode
   as the named buy/sell/approval case, and satisfy router, path, recipient,
   amount, chain, gas, and fee bounds. Each denial must be failed/rejected and
   carry a policy-denial failure. Fabricated IDs or unrelated failures cannot
   produce an attestation.
2. **Daily matrix cadence is explicit (B-2).** The runtime intentionally checks
   `matrix.runAt` on every attestation validation. Early micro-mainnet operation
   therefore requires the complete matrix to be rerun at least every 24 hours.
   This is documented as a manual operator safety ceremony.
3. **Preflight refusals become durable evidence (B-3).** A preflight denial or
   exception is recorded as a final `rejected` execution-journal record with
   stage and coded failures before returning. It is excluded from pending
   executions. If rejection persistence fails, the lifecycle returns
   `preflight-rejection-journal-failed`; it still performs no spend, nonce, or
   provider action.

## Matrix input contract

```json
{
  "runAt": 0,
  "allows": [
    { "case": "buy", "activityId": "..." },
    { "case": "sell", "activityId": "..." },
    { "case": "approval", "activityId": "...", "token": "0x...", "amount": "1" }
  ],
  "denials": [
    { "case": "wrong-chain", "activityId": "..." }
  ]
}
```

The twelve required denial case names are: `wrong-chain`, `non-zero-value`,
`foreign-router`, `wrong-selector`, `excessive-input`,
`zero-minimum-output`, `three-token-path`, `wrong-weth-orientation`,
`foreign-recipient`, `excessive-gas-or-fee`, `foreign-approval-spender`, and
`approve-max-uint`. More denial entries are allowed, but every activity ID must
be unique. The digest is computed from the verified ordered activity-ID set.

The activity response fields used by the verifier match Turnkey's public
OpenAPI schema: `Activity.organizationId/status/type/intent/result/votes/failure`
and `SignTransactionIntentV2.signWith/unsignedTransaction`.

## Deliberate remaining blockers

1. Run the behavioral matrix against the real organization and independently
   review the sanitized activities before creating the first attestation.
2. Persist and reconcile `ExecutionJournal`, `NonceLane`, and `SpendLedger`
   through the state/evidence checkpoint protocol; source pending executions
   from the restored journal.
3. Implement journaled exact-approval orchestration, including zero-first and
   residue cleanup where required.
4. Implement the mandatory preflight with fresh policy-set, WETH/native-balance,
   daily-spend, and post-buy sell-probe checks.
5. Bind eligible strategy decisions to immutable intents and complete a
   qualifying V6b cohort.

## Reviewer questions

1. Can fabricated IDs, wrong users/wallets, unrelated failures, or malformed
   successful transactions satisfy the matrix?
2. Are all three successful transactions decoded and bound to the configured
   limits and expected case?
3. Does a preflight refusal become final evidence without reserving spend or a
   nonce and without provider access?
4. Is the daily operator cadence explicit and fail-closed?
5. Is the branch still incapable of transaction submission?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure private keys.
- Enable micro-mainnet: **NO-GO**.
