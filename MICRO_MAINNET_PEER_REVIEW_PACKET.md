# Atlas Micro-Mainnet Execution Boundary — Revision 4 Review Packet

## Scope

Review branch `fix/micro-mainnet-execution`, revision 4, based on production
commit `5fa5fd91ebe53069eb5ba0582451f95a0e58f7cf` and compared with revision 3
`5842cbac5b8110cca57ed1c641b9afed91da891f`. Production remains V6b
`PAPER_ONLY`. This branch is inert and is not an execution release.

This revision responds only to A-1 through A-4. It changes dormant execution
scaffolding, external verification, startup safety, tests, and documentation.

## Safety boundary

No transaction can be submitted. There is no POST endpoint or
candidate-to-intent call; the provider and lifecycle are not imported by the
web runtime. `submissionPathConnected` and `automaticSubmissionEnabled` remain
literal `false`. The web runtime cannot read a signing private key and now
refuses to start if one-shot signing or attestation private material is present.

## Changes since revision 3

1. **Behavioral proof is bound into the attestation (A-1).** The one-shot
   verifier requires a recent JSON matrix containing three allowed Turnkey
   activity IDs and at least twelve distinct denied activity IDs. It refuses to
   issue an attestation without that evidence. Signed claims contain the run
   timestamp, counts, and SHA-256 digest of the ordered IDs, not the IDs.
2. **Public failures are fixed codes (A-2).** Attestation I/O, Turnkey
   revalidation, and WETH balance failures map to
   `signing-attestation-read-failed`, `turnkey-revalidation-failed`, and
   `weth-balance-read-failed`. SDK/RPC error text no longer reaches status.
3. **Private-key custody is enforced (A-3).** Startup rejects
   `TURNKEY_SIGNING_API_PRIVATE_KEY`,
   `TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY`, or
   `TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64`. The web service may hold
   only the observer credential, signing public key, attestation public key,
   and signed attestation document.
4. **Per-intent revalidation is structural (A-4).** `ExecutionLifecycle`
   requires a `preflight` callback. It runs after static policy/calldata checks
   and before spend or nonce reservation. A denial or exception fails closed
   without provider access. When connected, the callback must perform fresh
   Turnkey policy and wallet-balance reads on every intent.

## Behavioral matrix contract

Input JSON:

```json
{
  "runAt": 0,
  "allows": ["allowed-buy-activity-id", "allowed-sell-activity-id", "allowed-approval-activity-id"],
  "denials": ["denied-activity-id-1", "... eleven or more distinct IDs"]
}
```

`runAt` must be within 24 hours and no more than five minutes in the future.
The operator must actually test valid buy, sell, and allowlisted exact approval.
Denials must cover wrong chain, native value, foreign router, wrong selector,
excessive input, zero minimum output, three-token path, wrong WETH orientation,
foreign recipient, excessive gas/fee, foreign approval spender, and
`approve(MAX_UINT)`. The attestation proves the supplied activity-ID set was
bound to the reviewed configuration; it does not replace independent review of
the sanitized activity results.

## Deliberate remaining blockers

1. Execute the matrix against the real Turnkey organization and independently
   review the sanitized activity outcomes before creating the attestation.
2. Persist and reconcile `ExecutionJournal`, `NonceLane`, and `SpendLedger`
   through the state/evidence checkpoint protocol; source pending executions
   from the journal.
3. Implement journaled exact-approval orchestration, including zero-first and
   residue cleanup where required.
4. Supply the preflight implementation: exact policy revalidation, WETH and
   native-gas balance checks, daily spend state, and post-buy sell re-probe.
5. Bind an eligible strategy decision to an immutable intent and complete a
   qualifying V6b cohort.

## Reviewer questions

1. Can an attestation be issued or accepted without a recent complete matrix?
2. Can an SDK, filesystem, or RPC error expose raw text through public status?
3. Can either signing or attestation private material coexist with the web
   runtime?
4. Can an intent reserve spend, reserve a nonce, or call the provider without a
   successful fresh preflight?
5. Is the branch still incapable of transaction submission?
6. What persistence and approval work remains before connecting the provider?

## Expected verdict

- Merge as inert scaffolding: reviewer decision.
- Deploy to production: no operational benefit; do not configure private keys.
- Enable micro-mainnet: **NO-GO**.
