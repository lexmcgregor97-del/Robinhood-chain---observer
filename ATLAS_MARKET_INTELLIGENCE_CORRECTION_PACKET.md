# Atlas — Market Intelligence Corrections Review

## Scope

Corrections for M-1 through M-6 from the review of `50ad394`, plus an explicit
exit-impact measurement required by the lifecycle sizing contract.

## Resolutions

- **M-1:** Explicit expansion breadth now wins ambiguous ties. Contraction
  requires both low active breadth and low median acceleration. Tests pin an
  all-expanding/low-acceleration market and a low-breadth/high-acceleration
  market.
- **M-2:** Removed the ambiguous `confidence`. Results now report independent
  `coverageConfidence` and `separationMargin` fields.
- **M-3:** Relative strength uses fixed saturating transforms, so the same
  candidate receives the same numeric score in one-item and ten-item sets.
- **M-4:** Replacement requires a known incumbent state and positively permits
  only `weakening` or `invalidated`; missing and unknown states fail closed.
- **M-5:** The caller contract documents mark-before-close ordering and returns
  `recordBeforeClose: true` as a machine-visible invariant. End-to-end ledger
  ordering remains an activation blocker for the future cohort patch.
- **M-6:** Outlier dependence requires at least five trades remaining after
  removal. Smaller samples return `"insufficient-sample"` rather than a claim.
- Counterfactual same-mark precedence is documented and tested as stop, then
  take-profit, then trail. First-mark peak activation is pinned.

## Exit-impact correction

The existing `marketSafety.priceImpactPct` is buy-side impact. The V2 and V3
round-trip simulators now expose `sellPriceImpactBps`, and market safety exposes
the additive `exitPriceImpactPct`. The dormant lifecycle entry contract requires
that explicit exit-side field and fails if it is absent. No current risk gate,
ranking, cohort, promotion, readiness, execution, or signing behavior consumes
the new field.

## Safety boundary

- Market intelligence and lifecycle wiring remain unimported by `index.js`.
- No cohort is registered or activated.
- No replacement decision can mutate a portfolio.
- No live worker or execution module imports these research components.
- Existing market-safety behavior is unchanged; only exit-impact evidence is
  added to its returned record.

## Requested decisions

1. Are M-1 through M-6 closed?
2. Are the fixed score transforms sufficiently comparable for research use?
3. Is `exitPriceImpactPct` correctly derived from the exact simulated sell leg?
4. Is the tree safe to merge as dormant scaffolding?

## Follow-up corrections after verification

- **N-1:** A candidate must have current swaps before its state or acceleration
  contributes to expansion breadth. Stale `escape-velocity` labels on inactive
  candidates cannot manufacture broad expansion.
- **N-2:** `rotational-chop` separation is the minimum distance to its adjacent
  concentrated-expansion and contraction regions. The contraction distance
  respects that contraction requires both weak breadth and weak acceleration.
- The fixed score scales are exported as `RELATIVE_STRENGTH_SCALES` and pinned
  in a regression test.
- A shallow V2 rounding case pins asymmetric buy/sell impact (50/90 bps), and
  the lifecycle entry test proves the 90-bps exit leg selects the 30% boundary.
- **N-3 remains an activation invariant:** the future cohort must measure its
  own exact notional. Runtime registration is still absent from this tree.
