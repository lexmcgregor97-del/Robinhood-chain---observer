# Atlas V6 Risk Calibration — Peer Review Packet

## Review target

- Repository: `lexmcgregor97-del/Robinhood-chain---observer`
- Branch: `fix/v6-risk-exit`
- Baseline: `89dc196` (peer-reviewed V5 integrity deployment)
- Proposed epoch: `2026-09-15-paper-v6-risk-calibration`
- Intended deployment mode: `PAPER_ONLY`

Do not recommend live trading from this review. The requested decision is whether
V6 is safe and methodologically sound enough to begin a fresh qualifying paper
epoch.

## Frozen V5 result that motivated V6

V5 was paused with all positions closed. Its infrastructure and evidence systems
worked, but its strategy cohort failed:

- 48 closed paper trades, 0 open
- 16 wins, 32 losses
- 7 unique pools
- realized P&L: `-0.011027 WETH`
- expectancy: `-0.0002297 WETH/trade`
- maximum marked drawdown: `19.2797%`
- measurement failures: 0
- recovery gaps: 0
- RPC failures/rate limits: 0

Concentration was material: two pools supplied 27 of 48 trades. One pool produced
a `-0.009344 WETH` result with approximately `92.75%` executable exit impact.
V5's readiness drawdown limit was 10%, while its default paper entry circuit was
20%, allowing the cohort to keep taking entries after it could no longer qualify.

These results are retained as failed V5 evidence. V6 does not delete, reclassify,
or exclude any V5 loss.

## Proposed V6 changes

1. One shared drawdown boundary:
   - paper entry circuit: 10%
   - micro-mainnet readiness: 10%
   - circuit uses the worse of realized and persisted maximum marked drawdown
2. Reduce entry sizing from 10% to 5% of remaining paper cash.
3. Reduce per-pool dependence:
   - maximum 3 entries per pool per epoch
   - 15-minute same-pool re-entry cooldown
   - qualification requires at least 20 unique paper pools in addition to 50 closes
4. Test a tighter exit hypothesis in a fresh epoch:
   - executable stop: -8%
   - trailing activation: +10%
   - trailing drawdown: 6 percentage points
   - take profit: +35%
5. If executable exit impact reaches 20%, exit immediately with reason
   `liquidity-collapse`. The actual executable proceeds and full loss remain in
   P&L; this is a label and earlier risk response, not data exclusion.
6. Bump the paper epoch so V5 is archived and cannot contaminate V6 qualification.

## Integrity properties intentionally unchanged

- `PAPER_ONLY` remains the intended deployment mode.
- Exact base-unit exit quantities remain mandatory.
- Measurement failures remain cohort-invalidating.
- Hash-chained evidence journaling and state checkpoints remain mandatory.
- Gas receipt verification and gas-inclusive paper accounting remain mandatory.
- Turnkey attestation and independent read-only verification remain readiness
  requirements.
- Shadow evidence retains its existing independent-pool and bootstrap gates.
- Sell-path proof remains required for micro-mainnet.

## Validation

`npm test` passes `175/175` with dependencies present. New or updated regression
coverage verifies:

- entry and readiness drawdown defaults cannot drift apart;
- persisted marked drawdown triggers the entry circuit;
- a fourth entry into the same pool is rejected;
- the longer re-entry cooldown is enforced;
- the 20-unique-pool readiness requirement is fail-closed;
- high executable exit impact is labelled `liquidity-collapse`;
- exact-unit, drained-pool, measurement-failure, journal, gas, Turnkey, and
  execution-safety regressions continue to pass.

## Questions for the reviewer

1. Does any path still permit a paper entry after either realized or maximum
   marked drawdown reaches 10%?
2. Can restart, restore, archive, or multi-quote behavior bypass the three-entry
   per-pool epoch cap or the 15-minute cooldown?
3. Is `paper.uniquePools` computed from qualifying closed V6 trades such that the
   new 20-pool readiness gate cannot be inflated by legacy, open, or unmatched
   records?
4. Does the `liquidity-collapse` path always realize the same executable proceeds
   used for the trigger, without censoring or fabricating a zero?
5. Are the new exit thresholds internally consistent with gas-inclusive executable
   returns, or is any threshold applied to a different denominator?
6. Does the epoch bump cleanly archive V5 while starting a new evidence journal
   and empty V6 paper books?
7. Do the parameter changes create an unintended fail-open path, hidden selection
   bias, or strategy overfitting concern that should be corrected before the epoch?

## Requested verdicts

Please separately state:

- merge to `main`: Go / No-go
- deploy in `PAPER_ONLY`: Go / No-go
- begin the fresh V6 epoch: Go / No-go
- enable micro-mainnet: expected to remain No-go until a qualifying V6 cohort,
  sell-path proof, and every existing readiness gate pass
