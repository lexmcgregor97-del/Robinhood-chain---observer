# Atlas V5 Integrity Hardening — Verification Review

Review branch: `peer-review/v2-integrity-fixes`

Please verify the implementation against the findings in
`CLAUDE_REVIEW_PACKET.md`. This branch includes the original review snapshot,
the first integrity patch, and the additional fresh-epoch requirements.

## Implemented

- Exact token base-unit quantities are persisted and used for exit quotes.
- Measurement failures remain conservative losses but invalidate readiness.
- Confirmed drained V2 pools resolve shadow samples at -100% rather than being censored.
- Paper entries enforce a five-minute same-pool re-entry cooldown.
- Entry impact is capped at 1.5%; total modeled execution cost is capped at 4%.
- Configurable per-side gas is included in entry cost, exit proceeds, P&L,
  marked position value, and the execution-cost gate.
- Paper analytics publish unique pools, measurement failures, realized drawdown,
  marked drawdown, gas paid, and estimated LP fees.
- Restored paper ledgers must satisfy the cash/positions/P&L invariant.
- Every paper open/close and shadow open/resolve is written to a SHA-256 chained
  JSONL evidence journal.
- Evidence sequence is checkpointed with mutable state. Any restart divergence,
  journal corruption, unavailable journal, or state-write failure blocks automation.
- `/api/evidence` streams the current epoch journal as NDJSON.
- Recovery-skipped blocks invalidate readiness for the epoch.
- Observed paper-cycle cadence, paper unique pools, measurement failures,
  recovery gaps, shadow hold-time distribution, and bootstrap parameters are published.
- Paper epoch bumped to `2026-09-14-paper-v5-integrity`.
- Shadow epoch bumped to `2026-09-14-measurement-v3-integrity`.
- Turnkey now requires a policy ID and explicit read-only attestation; readiness
  fails with `turnkey-policy-not-attested` until configured.
- README and `.env.example` now describe the actual credential boundary and cadence.

## Validation

- `npm test`: 154 passed, 0 failed
- `npm run check`: passed
- `git diff --check`: passed
- Embedded-secret pattern scan: no match

## External item intentionally unresolved

The repository cannot create or independently prove a Turnkey policy. Before
deployment, the operator must create a dedicated Turnkey API user/policy that
allows wallet-account reads and denies signing/activity creation, rotate its
credential, then set `TURNKEY_POLICY_ID` and
`TURNKEY_READ_ONLY_ATTESTED=true` in Railway. Treat the environment attestation
as an operator assertion and assess whether an API-level policy verification is
available and preferable.

## Requested verdict

1. Confirm whether C-1 and H-1 through H-5 are adequately resolved.
2. Audit the evidence journal/state checkpoint protocol for crash windows,
   truncation, replay, concurrency, and information exposure.
3. Audit gas accounting and marked drawdown for double counting or omissions.
4. Verify the V5/V3 epoch isolation and migration from the current V4/V2 state.
5. Identify any Critical or High regression with file/line references and a test.
6. Give separate go/no-go verdicts for merging to `main`, deploying in
   `PAPER_ONLY`, beginning the fresh epoch, and enabling micro-mainnet.

Do not recommend weakening any gate. Micro-mainnet remains a no-go until a new
epoch passes and the sell-path proof plus Turnkey restriction are independently verified.
