# Robinhood Chain Observer

Read-only PancakeSwap V2/V3 pool and swap observer for Robinhood Chain (chain ID 4663).

## Safety boundary

- No wallet, private key, signer, transaction construction, or write RPC.
- No wallet, live trading, position sizing, or P/L logic.
- Paper-signal scoring ranks pool activity and acceleration; it never submits transactions.
- HTTP endpoints are GET-only.
- Scanner state is bounded and in memory; it resets on redeploy.

## Run

Requires Node.js 20 or newer.

```sh
npm start
```

Optional environment variables:

- `RPC_URL` (defaults to Robinhood Chain public RPC)
- `POLL_INTERVAL_MS` (defaults to `5000`)
- `PORT` (defaults to `3000`)
- `SIGNAL_WINDOW_BLOCKS` (defaults to `20`)
- `SIGNAL_MIN_SWAPS` (defaults to `3`)

Endpoints: `/`, `/health`, `/api/scanner`, `/api/pools`, `/api/signals`,
`/api/candidates`.

## Current build stage

`/api/signals` labels pools as `quiet`, `active`, `breakout-watch`, or
`escape-velocity` from recent swap count, acceleration versus the prior block
window, and recency. This is the first paper layer. Price, liquidity, honeypot,
slippage, virtual fills, and P/L gates must be added and validated before any
wallet or live-execution layer.

Swap payloads are decoded with `viem` and the latest raw token deltas are kept
on each pool. Human-normalized execution prices are available once token
decimals and quote-token classification pass the market-safety gate.

`/api/candidates` is deliberately fail-closed. A pool cannot become eligible
for a virtual entry until quote-token identity, liquidity, simulated buy and
sell success, pool age, price impact, and round-trip loss are all measured.

## Dedicated wallet boundary

The bot supports a dedicated EOA loaded from deployment secrets. It remains
disarmed unless `LIVE_TRADING_ENABLED` exactly matches the explicit arm phrase
and every required limit and router allowlist is valid. `/api/wallet` reveals
only configuration state and the public address—never key material.

Before signing is connected, every proposed transaction must pass chain-ID,
router allowlist, per-trade, daily-spend, gas, slippage, and calldata checks.
The current build can validate an intent but cannot broadcast it.

## Reuse policy

- `viem` (MIT): EVM ABI and RPC primitives.
- PancakeSwap SDK (MIT): approved for later route and price-impact math.
- Hummingbot (Apache-2.0): architecture reference only unless attribution is added.
- GPL/AGPL or unlicensed trading repositories: no copied code.
