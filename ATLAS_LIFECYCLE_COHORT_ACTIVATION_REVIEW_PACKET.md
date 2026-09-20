# Atlas — Review: Paired Signal-Conditioned Lifecycle Paper Cohort

## Decision requested

1. Is the fresh control-versus-lifecycle cohort safe to deploy while paper entries remain paused?
2. Does the activation preserve exact-size entry and exit evidence, frozen risk boundaries, and mark-before-close ordering?
3. Are the completed v7 and frequency ledgers genuinely frozen?
4. After a successful paused deployment, is it safe to set `PAPER_ENTRIES_PAUSED=false` for this paper-only experiment?

No live execution, signing, submission, automatic promotion, or capital replacement is requested. The live worker does not import the lifecycle policy. `submissionPathConnected` remains `false`.

## Why a new cohort

The prior epoch continued on Railway after the interactive session ended, but stalled below its readiness sample thresholds. It is now complete operationally: both cohorts have zero open positions and new entries are paused.

| Completed cohort | Closed lifecycles | Pools | Equity return | Profit factor | Max marked drawdown | Return without best 3 |
|---|---:|---:|---:|---:|---:|---:|
| v7 control | 38 | 17 | +6.243% | 1.439 | 5.861% | -0.243% average |
| frequency candidate | 34 | 15 | +2.986% | 1.247 | 4.954% | -2.049% average |

The result is positive but under-sampled and outlier-dependent. It is not promotion evidence. The old ledgers remain visible in status and persistence, but are removed from new cycle entry, exit, and measurement stages.

## Activated paper experiment

Two empty books begin on the same market clock:

- `2026-09-20-paper-lifecycle-control-v1`: the canonical v7 control entry and price-only lifecycle.
- `2026-09-20-paper-signal-conditioned-lifecycle-v3`: identical entry signals and safety gates, with risk-budgeted sizing and the reviewed signal-conditioned lifecycle.

The candidate can hold a profitable position while its signal remains healthy or strengthening. Weakening can unlock a 50% exact-unit partial and then an adaptive trailing exit. Invalidated or emergency signals close fully. A 20% or 30% entry adverse boundary is frozen at entry and cannot widen, and the 24-hour absolute hold remains the final fail-safe.

## Exact-notional entry measurement

The candidate is measured twice per candidate pool:

- 2% cash, corresponding to the 20% adverse boundary and 0.4% portfolio risk.
- 4/3% cash, corresponding to the 30% adverse boundary and 0.4% portfolio risk.

The 2% result is accepted only when its own simulated sell-leg impact is at most 0.5%. Otherwise the 4/3% result is accepted only when its own impact is above 0.5%. A cross-boundary result fails with `sizing-boundary-instability`; missing exit impact also fails closed. A control-sized fill is never rescaled into candidate evidence.

## Exit ordering and exact units

For every candidate mark, the caller performs this order:

1. Quote the entire current position in its exact base units.
2. Mark the position and assess current signal and sellability.
3. Persist `recordLifecycleMark` before any close mutation.
4. If partial, floor the policy fraction into exact base units and quote those units independently.
5. Append the partial/final trade evidence and atomically checkpoint all paper books.

The final close records both `entryAdverseBoundaryPct` and `appliedBoundaryPct`. A partial close records the signal state, trail width, and observed mark cadence while leaving the frozen boundary on the remaining position.

## Restart and evidence integrity

The state checkpoint gains named `paperResearchCohorts`. Each cohort is restored only when its exact version matches. Evidence reconciliation independently compares each named ledger's open, partial-close, and close records against journal type counts. A mismatch blocks restoration and paper automation.

The status route exposes both books, both strategy versions, comparison counters, partial-exit counts, and the explicit paper-only boundary.

## Old epoch freeze

The old v7 and frequency cohorts are not members of `runPaperCycle` after this patch. Unpausing cannot create another old-policy entry. Their persisted books and analytics remain readable, and existing live-readiness reporting remains based on the frozen v7 evidence rather than silently treating the new research cohort as promotion evidence.

The fresh cycle also asserts that every completed-epoch book is flat. If restored state unexpectedly contains an old open position, the fresh pair fails closed instead of abandoning it or starting new entries.

## Operational sequence

1. Review this exact tree.
2. Deploy with the existing `PAPER_ENTRIES_PAUSED=true` setting.
3. Verify restore, evidence health, empty paired books, and `submissionPathConnected:false`.
4. Explicitly unpause paper entries.
5. Collect across multiple days and at least two regimes; do not evaluate for research qualification before 100 complete lifecycles across 30 pools.

## Validation

- `npm run check`: pass.
- `npm test`: 484/484 pass.
- Focused lifecycle/wiring/checkpoint tests: 16/16 pass.
- `git diff --check`: pass.

## Files in this activation patch

- `index.js`: fresh paired registration, exact-size measurement, lifecycle exit caller, old-epoch freeze, persistence, evidence, and status.
- `paper-lifecycle-cohort.js` and test: exact-size selection and mark-before-partial/final-close adapter.
- `paper-lifecycle-candidate.js` and test: paper activation metadata and new cohort version; lifecycle rules otherwise unchanged.
- `paper-lifecycle-wiring.js` and test: boundary changes from dormant to registered paper runtime; live execution stays unsupported.
- `evidence-checkpoint.js` and test: independent named-cohort reconciliation.
- `package.json`: syntax-check coverage for the new adapter.

## Explicit non-changes

- No live-worker file changed.
- No Turnkey, wallet, signing, router, approval, nonce, spend, or execution module changed.
- No automatic promotion or evaluator invocation was added.
- V4 remains observation-only.
- The production environment remains entry-paused until a separate, explicit unpause step.
