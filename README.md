# Robinhood Chain Observer

A read-only Uniswap and PancakeSwap V2/V3 observer and paper-measurement service for Robinhood Chain (chain ID 4663).

## Safety boundary

- No wallet, private key, signer, transaction construction, or write RPC exists.
- No transaction can be signed or broadcast.
- Every HTTP endpoint is GET-only.
- New paper and shadow entries are paused during the measurement repair.
- Existing paper positions are marked and closed only in the virtual ledger.
- The dormant execution policy decodes supported V2 router calldata and rejects foreign recipients, unapproved paths, zero minimum output, long deadlines, and inconsistent native value. It is not connected to a signer.

MoonPay CLI supports Robinhood Chain swaps, but its current high-level swap command builds routes and approvals through swaps.xyz before signing locally. Atlas does not use that command for execution because it cannot yet independently validate the final unsigned transaction against this policy. MoonPay remains a candidate quote/execution adapter only after that boundary is separable.

## Measurement model

Swap activity is stored as timestamped per-block counts. Signals compare a 60-second window with a rate-normalized five-minute baseline; pool age is measured in elapsed time rather than block count.

Candidate safety is measured at the paper book's actual intended notional. V2 and bounded same-tick V3 quotes determine acquired quantity, execution price, sell proceeds, fees, and price impact. These calculations are AMM arithmetic, not a honeypot or transfer-tax simulation.

Shadow evaluation uses one five-minute horizon and one sample per rule/pool episode. Missing prices are censored rather than recorded as losses. Promotion requires at least 20 unique pools, a positive median, and a positive pool-cluster bootstrap lower confidence bound. Promotion remains advisory.

## Persistence

Mount a Railway volume at `/data` and set:

```sh
STATE_FILE=/data/observer-state.json
```

State is written atomically. A missing file starts cleanly. Corrupt, unsupported, or unreadable state blocks paper automation and all subsequent writes while leaving scanner health visible, preserving the original file for recovery.

## Run

Requires Node.js 20 or newer.

```sh
npm ci
npm test
npm start
```

See `.env.example` for configuration. WETH (18 decimals) and USDG (6 decimals) are pinned; failed metadata lookups for other tokens are not cached.

## Endpoints

- `/`
- `/health`
- `/api/scanner`
- `/api/pools`
- `/api/signals`
- `/api/candidates`
- `/api/paper`

## RPC reliability

All JSON-RPC calls pass through a serialized scheduler. The default spacing is 250–350 ms, with a shared cooldown on HTTP 429 responses and adaptive poll backoff.

## Reuse policy

- `viem` (MIT) supplies ABI decoding and EVM primitives.
- No GPL/AGPL or unlicensed trading-bot code is copied into this repository.
