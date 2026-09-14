# Atlas Trader V2 Paper-Epoch Peer Review Packet

## Review target

- Repository: `lexmcgregor97-del/Robinhood-chain---observer`
- Review branch: `peer-review/v2-50-sample`
- Code baseline: `a26226e` (`Start executable V2 paper qualification epoch`)
- Runtime mode: `PAPER_ONLY`
- Network: Robinhood Chain mainnet, chain ID 4663
- Paper epoch: `2026-09-14-paper-v4-v2-fast-exit`
- Evidence captured: 2026-09-14 21:49:43 UTC

This packet requests an independent code, safety, data-integrity, and strategy-readiness review. It is not a request to enable live trading. The current cohort fails promotion.

## Executive result

Atlas crossed the required sample-size threshold with 51 closed V2 paper trades and two open positions. The cohort did not pass the remaining quantitative gates:

| Metric | Result | Policy | Status |
|---|---:|---:|---|
| Closed qualifying paper trades | 51 | >= 50 | Pass |
| Wins / losses | 20 / 31 | Informational | — |
| Win rate | 39.22% | Informational | — |
| Realized P&L | -0.00905373 WETH | > 0 implied by expectancy | Fail |
| Expectancy per trade | -0.000177524 WETH | > 0 | Fail |
| Maximum realized drawdown | 13.39% | <= 10% | Fail |
| Sell-path proof | Not ready | Required | Fail |
| Mode | `PAPER_ONLY` | Must remain paper-only | Pass |

Micro-mainnet eligibility is false. Exact readiness failures at capture were:

- `paper-expectancy-not-positive`
- `paper-drawdown-too-high`
- `sell-probe-not-ready`
- `runtime-not-ready` (the scanner was transiently 130 blocks behind while processing; RPC remained healthy)

## Exit distribution

| Exit reason | Trades | P&L (WETH) | Mean return |
|---|---:|---:|---:|
| Stop loss | 31 | -0.05201514 | -20.18% |
| Take profit | 5 | +0.02580193 | +59.48% |
| Trailing stop | 15 | +0.01715948 | +13.48% |

Average hold time was approximately 146 seconds. Fees recorded for the cohort were 0.00261384 WETH.

## Operational evidence

- Health status: `ok`
- Uptime: 3,702 seconds
- Scanner head/cursor: 63,138,886 / 63,138,756 (130-block working lag at capture)
- Successful/failed polls: 436 / 0
- RPC requests/failures/rate limits/failovers: 11,285 / 0 / 0 / 0
- Turnkey: configured, authenticated, wallet visible, address matched; no verification error
- Paper automation: 280 cycles, 53 entries, 51 exits, no last error
- Shadow epoch: 504 samples (473 closed, 3 open, 28 censored)
- Shadow unique pools: 66
- All three shadow rules reported `promotion-candidate`

The live public evidence endpoints are:

- `https://observer-v3-production.up.railway.app/health`
- `https://observer-v3-production.up.railway.app/api/paper`

Treat those endpoints as moving runtime state. The values above are the frozen review snapshot.

## Known concern: extreme shadow-price collapses

The shadow stream has repeatedly recorded approximately total five-minute price collapses. Two recent examples were:

- Pool `0xab2c6af1fdc6ec10f1e25c32324e4993a614480e`: gross return approximately -99.42%.
- Pool `0x06da20c0cbf30bcbb42ef62b16f98453833b667c`: gross return approximately -99.99996%.

These events were observed in shadow measurement and were not among the most recent qualifying-paper closes, whose visible losses were ordinary stop exits. Determine whether the extreme observations represent genuine liquidity/rug events or a token-decimal, reserve-orientation, stale-swap, or price-normalization defect. Do not discard them as outliers without reconstruction.

Current forensic limitation: `/api/paper` publishes only the most recent 20 ledger events. Older entry/exit details rotate out, and shadow samples do not retain entry/exit block numbers or reserve snapshots. Please assess whether immutable per-trade evidence must be added before another qualification epoch.

## Code map

- `index.js`: runtime orchestration, scanning, V2/V3 measurements, paper loop, health APIs
- `paper-strategy.js`: entry sizing, position limits, exit policy, drawdown circuit breaker
- `paper-portfolio.js`: ledger, positions, explicit simulated fills, P&L
- `paper-analytics.js`: epoch isolation, expectancy, drawdown, grouped outcomes
- `market-safety.js`: reserve/tick measurements and simulated executable liquidity
- `v2-simulator.js`: constant-product buy/sell quote math
- `risk-gate.js`: signal, liquidity, execution-cost, age, and price-audit gates
- `price-audit.js`: reserve-derived spot versus latest swap comparison
- `shadow-evaluator.js`: frozen five-minute rule measurement and promotion statistics
- `rpc-log-query.js`, `rpc-transport.js`, `rpc-scheduler.js`: bounded query splitting, failover, throttling
- `turnkey-probe.js`: read-only wallet/configuration verification
- `live-readiness.js`: fail-closed micro-mainnet eligibility
- `execution-*`, `router-calldata.js`, `approval-calldata.js`, `spend-ledger.js`, `nonce-lane.js`: dormant live-execution safety boundary

## Required review questions

1. Is V2 reserve orientation correct for both quote-token directions in entry and exit simulation?
2. Is converting `BigInt` token amounts through JavaScript `Number` safe at every supported decimal and reserve magnitude?
3. Can fee accounting, `costBasis`, explicit filled quantity, or exit proceeds double-count or omit fees?
4. Can pool identity, token metadata, or cached state become stale or mismatched after restart?
5. Does the spot-versus-last-swap audit adequately reject manipulated, stale, or dust swaps?
6. Are 12% stop triggers being realized near -20% on average because of scan cadence, fast market movement, AMM impact, or a calculation defect?
7. Is maximum realized drawdown computed appropriately for this position-sizing and multi-position portfolio model?
8. Can repeated re-entry into the same volatile pools bias the sample or violate statistical independence?
9. Does the shadow promotion method remain valid when approximately total collapses occur and samples can be censored for unavailable prices?
10. Are runtime readiness and sell-path proof truly fail-closed under all restart, RPC-failover, and partial-persistence states?
11. Is any private key, API credential, endpoint credential, wallet secret, or signing authority exposed by source, tests, logs, or APIs?
12. What changes are required before beginning a fresh, immutable qualifying epoch?

## Requested output from Claude

Please provide:

1. Findings ranked Critical / High / Medium / Low, each with file and line references.
2. A direct verdict for code integrity, paper-data integrity, strategy validity, and live-trading readiness.
3. Reproduction steps or tests for every Critical or High issue.
4. A specific explanation for the average stop-loss realization versus the configured stop threshold.
5. A forensic plan for the extreme shadow collapses.
6. Minimal patches and regression tests, but do not weaken any safety gate.
7. A go/no-go recommendation for a new paper epoch; live trading must remain no-go unless every current blocker and any new Critical/High finding is cleared.

## Local validation performed before publication

- `npm test`: 139 passed, 0 failed
- `npm run check`: passed
- `git diff --check`: passed
- Pattern scan for embedded private keys, OpenAI-style secret tokens, populated `TURNKEY_API_PRIVATE_KEY`, and credential-bearing `/v2/<key>` URLs: no match

Passing tests are evidence of implemented behavior, not proof of strategy correctness or production safety.
