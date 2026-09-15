# Atlas Micro-Mainnet Execution Boundary — Revision 7 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 7, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf` and compared with revision 6
`bcd33cac70ff7d81a49535c57ad8f909f761de25`. Production remains V6b
`PAPER_ONLY`. This branch remains inert and is not an execution release.

Revision 7 responds only to D-1 and documents D-2. It changes the isolated
matrix verifier, tests, and documentation. The dormant lifecycle/journal is
unchanged.

## Safety boundary

No transaction can be submitted. There is no POST endpoint or
candidate-to-intent call; the provider and lifecycle are not imported by the
web runtime. `submissionPathConnected` and `automaticSubmissionEnabled` remain
literal `false`. No signing or attestation private material can coexist with
the web runtime.

## Changes since revision 6

1. **Turnkey serialized-hex normalization (D-1).** One helper now accepts signed
   and unsigned transaction payloads with or without a `0x` prefix. It first
   requires a non-empty, even-length hexadecimal body, then adds the canonical
   prefix before `parseTransaction` or signer recovery. Invalid, odd-length, or
   non-hex input continues to fail closed with the existing transaction-invalid
   codes.
2. **Both response forms are pinned in tests.** The complete three-allow and
   twelve-denial matrix passes with prefixed payloads and again after every
   activity payload has its prefix removed. Malformed signed and unsigned input
   is rejected before parsing.
3. **Denial scope is explicit (D-2).** The twelve current denial cases are
   intentionally buy-shaped or approval-shaped. A future sell-specific denial
   must add an explicit sell classifier; it must not be routed through the buy
   classifier.

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

1. Are prefixed and unprefixed Turnkey transaction payloads normalized identically?
2. Do malformed, empty, odd-length, and non-hex payloads remain fail-closed?
3. Does normalization occur before both parsing and signer recovery?
4. Is the current buy/approval denial-classifier scope explicit?
5. Is the branch still incapable of transaction submission?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure private keys.
- Enable micro-mainnet: **NO-GO**.
