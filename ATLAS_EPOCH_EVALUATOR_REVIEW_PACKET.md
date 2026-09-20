# Atlas — Dormant Evidence-Grade Epoch Evaluator Review

## Requested decisions

1. Is the evaluator safe to merge as dormant research scaffolding?
2. Is the evidence schema strict enough to prevent incomplete or duplicated
   lifecycles from appearing qualified?
3. Are status precedence and the frozen qualification thresholds coherent?
4. Do the pessimistic stress and outlier/regime tests support research claims
   without making an automatic promotion claim?

## Added surface

- `epoch-evaluator.js` and deterministic tests.
- One additive syntax-check entry in `package.json`.
- No import from `index.js` or any paper/live runtime module.

## Frozen research policy

- At least 100 closed trades and 30 unique pools.
- At least two regimes with 15 trades each.
- Profit factor at least 1.3 and positive expectancy.
- Portfolio drawdown no greater than 10%.
- No pool may account for more than 20% of trades.
- Remove the best three trades and require at least 25 remaining observations.
- Re-evaluate expectancy with one additional percentage point of slippage per
  trade and doubled recorded gas cost.
- Zero measurement failures, duplicate episodes, malformed records, orphaned
  partial closes, or risk-budget breaches.

## Evidence required per lifecycle

- Unique episode ID and closure timestamp.
- Pool and classified market regime.
- Net position return and portfolio P&L contribution.
- Recorded gas cost as a percentage.
- Complete lifecycle marker and explicit measurement-failure boolean.
- Entry cash percentage, frozen adverse boundary, optional applied boundary,
  and declared portfolio-risk budget.

Malformed records are counted and invalidate the epoch; they are never silently
dropped. Drawdown is calculated after sorting by closure time, so input order
cannot alter the result.

Duplicate episode IDs invalidate the epoch and every occurrence of the
ambiguous episode is excluded from all analytics. The output reports both
validated and analyzed record counts and marks performance derived alongside
any integrity failure. Equal closure timestamps use the episode ID as an
explicit drawdown-order tie-breaker.

An all-winning sample has no loss denominator. It reports a `null` profit
factor together with `profitFactorDefined: false` and
`profitFactorReason: "undefined-no-losses"`; it does not silently present the
missing ratio as a measured pass. A qualified all-winning epoch also carries
`qualificationCaveats: ["profit-factor-undefined-no-losses"]`, keeping the
non-blocking exemption visible beside its status and blockers.

Measurement failures and risk-budget breaches are counted across every valid
record, including duplicated episodes excluded from analytics. Pool, regime,
return, stress, concentration, and drawdown statistics use only the analyzed
population. Integrity accounting and statistical accounting therefore cannot
hide one another's failures.

## Status precedence

1. `invalid-evidence`
2. `insufficient-sample`
3. `outlier-dependent`
4. `regime-dependent`
5. `edge-not-demonstrated`
6. `paper-research-qualified`

All outputs include `automaticPromotion: false`. Qualification means only that
the supplied paper evidence cleared the frozen research criteria.

The thresholds intentionally define a multi-day, multi-regime collection, not
a 24-hour throughput target. Reaching 100 closed trades across 30 pools is not
sufficient unless the evidence also spans at least two independently sampled
market regimes.

## Safety boundary

`EPOCH_EVALUATOR_BOUNDARY` fixes runtime, paper mutation, automatic promotion,
and live execution support to `false`. The evaluator has no imports, I/O,
clock, randomness, ledger access, signing access, or mutation of inputs.

## Explicitly not included

- No adapter from the running epoch or persisted state.
- No API/status route.
- No cohort registration or activation.
- No promotion, deployment, wallet, signing, or execution change.
