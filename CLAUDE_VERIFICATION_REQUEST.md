# Atlas V5 Integrity Hardening — Fifth Verification Review

Review branch: `peer-review/v2-integrity-fixes`

Please verify the implementation against the findings in
`CLAUDE_REVIEW_PACKET.md`. This branch includes the original review snapshot,
the first integrity patch, and the additional fresh-epoch requirements.

This revision responds to the fourth review's X-1 through X-3 findings while
retaining all prior integrity fixes.

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
- Journal append or checkpoint failure sets `writeBlocked`; no later poll or
  shutdown write may persist an unjournaled ledger mutation.
- State now checkpoints both evidence sequence and terminal hash. Restore also
  reconciles paper-open/paper-close journal counts with all current book trades.
- Journal writes are explicitly `fsync`ed before the in-memory sequence advances.
- The running evidence hash and per-type counts are published in `/health`.
- A normal restored deployment scans up to the full 20,000-block backfill gap;
  the 300-block skip limit remains only for mid-run stalls.
- Legacy shadow resolutions are excluded from the V5 journal.
- Marked drawdown is persisted as a running maximum per paper book and updated
  immediately after every mark; current and maximum marked drawdown are separate.
- Paper return percentages now use cost basis (notional plus entry gas).
- V3 zero active liquidity is explicitly censored as `active-liquidity-zero`;
  it is no longer misclassified as a drained pool or a -100% outcome.
- Turnkey now queries `getWhoami`, organization quorum configuration, policies,
  and the API user's keys. Readiness requires both operator attestation and API
  verification that the credential belongs to a non-root user with zero
  applicable ALLOW policies and an applicable attested DENY policy. No activity
  denylist or condition parser is used.
- Gas constants qualify only after Atlas fetches a successful recent receipt,
  verifies its destination against an explicit V2-router allowlist, includes a
  receipt-provided L1 fee component, and confirms the WETH constant is at least
  the observed cost. Public status omits the transaction hash.
- Restore status publishes restart downtime. Crash-after-journal-before-state
  recovery remains deliberately fail-closed and its quarantine/new-epoch
  procedure is documented; automatic replay is not enabled.
- Nitro/Orbit receipts now prove the L1 component with
  `gasUsedForL1 <= gasUsed`; Atlas uses `gasUsed * effectiveGasPrice` as the
  already-inclusive total and does not add the L1 portion twice. OP-style
  `l1Fee` receipts retain their separate-fee accounting.
- Gas verification repeats hourly (minimum configurable interval: one minute),
  and every recheck fails the entry gate closed if assumptions regress.
- Public gas status exposes `observedCostWeth`, `measuredAt`, and
  `lastVerifiedAt`, but no receipt block, router, or measurement transaction.

## Validation

- `npm test`: 171 passed, 0 failed
- `npm run check`: passed
- `git diff --check`: passed
- Embedded-secret pattern scan: no match

## External items intentionally unresolved

The operator must still create/confirm a dedicated non-root Turnkey API user,
rotate its credential, and set `TURNKEY_POLICY_ID` plus
`TURNKEY_READ_ONLY_ATTESTED=true`. Atlas now independently inspects the user,
credential ownership, root quorum, and policies at startup; the human attestation
remains an additional requirement.

A real Robinhood Chain V2 swap receipt must still be measured for total gas cost.
Set `PAPER_WETH_GAS_PER_SIDE`, `PAPER_GAS_MEASUREMENT_TX`, and the independently
confirmed `PAPER_V2_ROUTER_ADDRESSES` allowlist. The receipt's block timestamp is
the measurement time; an operator-supplied timestamp is not trusted. If the
receipt lacks a verifiable L1 fee component, Atlas remains blocked. USDG gas is
not treated as verified by a WETH receipt. Until then fresh-epoch entries fail
closed with `gas-estimate-required`.

## Requested verdict

1. Confirm whether X-1 through X-3 are adequately resolved.
2. Re-audit the evidence journal/state checkpoint protocol for crash windows,
   truncation, replay, concurrency, and information exposure.
3. Audit gas accounting and marked drawdown for double counting or omissions.
4. Verify the V5/V3 epoch isolation and migration from the current V4/V2 state.
5. Identify any Critical or High regression with file/line references and a test.
6. Give separate go/no-go verdicts for merging to `main`, deploying in
   `PAPER_ONLY`, beginning the fresh epoch, and enabling micro-mainnet.

Do not recommend weakening any gate. Micro-mainnet remains a no-go until a new
epoch passes and the sell-path proof plus Turnkey restriction are independently verified.
