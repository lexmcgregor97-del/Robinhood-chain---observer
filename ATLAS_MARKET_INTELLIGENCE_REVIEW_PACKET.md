# Atlas — Dormant Market Intelligence and Lifecycle Research Review

## Requested decisions

1. Are these modules safe to merge as dormant research scaffolding?
2. Are regime classification, relative-strength ranking, and replacement planning deterministic and internally coherent?
3. Does the lifecycle caller contract preserve exact-size executable evidence, the frozen entry boundary, and monotonic mark time?
4. Do counterfactual and outlier-robustness analytics make no execution or promotion claims?

## Added surface

- `market-intelligence.js`: classifies broad expansion, concentrated expansion, rotational chop, contraction, or unavailable coverage; ranks executable relative strength; and evaluates a high-threshold replacement counterfactual.
- `lifecycle-research.js`: replays fixed stop/target/trail counterfactuals, measures dependence on the best trades, and reports boundary/cadence distributions.
- `paper-lifecycle-wiring.js`: a pure, dormant caller contract for exact-size entry planning and auditable lifecycle marks.
- Focused deterministic tests for each module.

## Safety boundaries

- No new module is imported by `index.js`.
- `MARKET_INTELLIGENCE_BOUNDARY` disables runtime entry, replacement, and live execution.
- `PAPER_LIFECYCLE_WIRING_BOUNDARY` disables cohort registration, runtime use, and live execution.
- The entry contract requires the executable fill to have been measured at the risk-budgeted lifecycle notional; it never rescales a control-sized simulated fill.
- The mark contract rejects a missing or non-monotonic clock before mutation and carries the entry/applied boundary and mark cadence into exit evidence.
- No state schema, control cohort, frequency cohort, promotion rule, readiness input, signing policy, wallet path, or live worker changes.

## Hypotheses now measurable

- Whether expansion is broad or concentrated rather than inferred from one token.
- Whether a candidate is strong relative to simultaneous activity after execution-cost penalties.
- Whether replacing a weakening incumbent would have overcome estimated rotation cost.
- Whether lifecycle profitability survives removal of the best one to three trades.
- Whether fixed take-profit rules systematically surrender signal-supported upside.
- Whether the 20%/30% frozen boundaries and per-mark trail assumption behave as designed.

## Explicitly not included

- No active lifecycle cohort.
- No automatic position replacement.
- No regime-based entry permission or sizing.
- No use of relative-strength scores in current ranking.
- No deployment or live execution support.

## Activation blockers

- Peer review of formulas, normalization, and caller contracts.
- A fresh isolated cohort with its own durable books, automation state, evidence prefixes, and epoch identity.
- End-to-end tests for partial-close journal ordering and per-position failure isolation.
- Frozen promotion thresholds defined before observing cohort results.
