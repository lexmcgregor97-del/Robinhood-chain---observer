# Atlas Micro-Mainnet Execution Boundary — Revision 6 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 6, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf` and compared with revision 5
`2629a5c75fbb742c93426b051b7869fe4568646d`. Production remains V6b
`PAPER_ONLY`. This branch remains inert and is not an execution release.

Revision 6 responds only to C-1 through C-3. It changes the isolated matrix
verifier, tests, and documentation. The dormant lifecycle/journal is unchanged.

## Safety boundary

No transaction can be submitted. There is no POST endpoint or
candidate-to-intent call; the provider and lifecycle are not imported by the
web runtime. `submissionPathConnected` and `automaticSubmissionEnabled` remain
literal `false`. No signing or attestation private material can coexist with
the web runtime.

## Changes since revision 5

1. **Denied activities prove the named case (C-1).** The verifier parses each
   `SignTransactionIntentV2.unsignedTransaction` and independently classifies
   its deviations from an otherwise allowed request. The deviation set must be
   exactly the matrix entry's case. Relabelled denials and requests containing
   a second defect fail with `matrix-denial-case-mismatch`. Approval cases are
   decoded separately from buy-shaped swap cases.
2. **Policy-denial parsing remains provisional (C-2).** Organization, status,
   type, approving signing-user vote, wallet, and the exact unsigned request are
   structural checks. Recognition of the denial reason remains a conservative
   regex over serialized `Activity.failure`. The first real matrix run must pin
   Turnkey's actual failure field/code before execution is connected.
3. **Rejected-record persistence is scoped honestly (C-3).** Revision 5 made a
   preflight rejection a final execution-journal record. The dormant journal
   still must be wired into checkpointed state and evidence, and evidence
   consumers must accept `rejected` records before submission is connected.

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
be unique. Each denied unsigned transaction must contain exactly the defect
named by its case and otherwise satisfy the allowed buy or approval shape. The
digest is computed from the verified ordered activity-ID set.

The activity response fields used by the verifier match Turnkey's public
OpenAPI schema: `Activity.organizationId/status/type/intent/result/votes/failure`
and `SignTransactionIntentV2.signWith/unsignedTransaction`.

## Deliberate remaining blockers

1. Run the behavioral matrix against the real organization and independently
   review the sanitized activities before creating the first attestation. Pin
   the exact structured Turnkey policy-denial field/code observed in that run.
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

1. Can one denied transaction be relabelled as multiple required cases?
2. Does every denial contain exactly its named deviation while remaining valid
   in every other policy-bound field?
3. Is the provisional failure regex clearly blocked on real-org schema capture?
4. Is rejected-record checkpoint/evidence integration still listed as required?
5. Is the branch still incapable of transaction submission?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure private keys.
- Enable micro-mainnet: **NO-GO**.
