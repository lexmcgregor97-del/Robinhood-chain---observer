# Atlas — Signal-Conditioned Lifecycle and V4 Observation Review

## Requested decisions

1. Is this safe to merge as dormant paper/research scaffolding?
2. Does the lifecycle candidate remain completely disconnected from the active cohort and live worker?
3. Are the signal-state, risk-budget sizing, and liquidity-conditioned adverse-boundary rules internally coherent?
4. Does V4 remain observation-only with no paper, routing, quoting, or execution eligibility?

## Scope

- Extracts the current v7 control entry policy into `paper-control-policy.js` without changing its values.
- Replaces the dormant lifecycle candidate's relaxed frequency entries with the exact control entry policy.
- Removes price-only stop, target, and time-exit semantics from the dormant candidate.
- Adds strengthening, healthy, weakening, invalidated, and emergency position states.
- Holds profitable positions while their signal remains healthy or strengthening.
- Selects a 20%/30% adverse boundary from entry-time exit impact, freezes it on the position, and never widens it after entry.
- Reduces prospective entry sizing to 2% or 1.333% and records the frozen boundary to preserve a 0.4% portfolio risk budget.
- Uses an explicit 5% exit-impact liquidity-collapse emergency; weakening alone cannot retroactively tighten a losing position's boundary.
- Takes a 50% partial only after a profitable position's signal weakens.
- Persists counterfactual −8%, −15%, −20%, and −30% breach/recovery telemetry.
- Records observed mark cadence beside the per-mark volatility trail assumption.
- Adds strict read-only Uniswap V4 Initialize/Swap decoders and pins Robinhood's PoolManager/StateView outside the executable factory list.

## Explicitly not included

- No lifecycle cohort wiring or activation.
- No change to the current control or frequency cohort behavior.
- No deployment.
- No live-worker, signing, policy, wallet, routing, approval, or execution change.
- No V4 discovery loop, pricing, StateView reader, hook simulation, sellability proof, paper eligibility, or execution.

## Verification

- Focused lifecycle/portfolio/V4 suite: 42/42.
- Full suite: 442/442.
- `npm run check`: pass.
- `git diff --check`: pass.

## Activation blockers

- Lifecycle caller wiring must provide fresh signal and market-safety evidence on every mark.
- Exact partial-close journal ordering and cohort analytics must be re-reviewed after wiring.
- The current epoch must remain immutable; activation requires a fresh isolated cohort.
- V4 needs pool discovery, StateView reads, hook-aware delta/price simulation, exact buy/sell quote validation, sellability proof, and adversarial review.
