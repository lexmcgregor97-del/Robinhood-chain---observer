# Atlas Trader

A compact, safety-first multichain trading core. Its first adapter is a read-only Uniswap and PancakeSwap V2/V3 observer and paper-measurement service for Robinhood Chain (chain ID 4663).

## Safety boundary

- No signer is wired into the observer runtime and no transaction can currently
  be signed or broadcast. A policy-restricted Turnkey API credential is held
  only for wallet-account verification; its policy must deny signing and
  activity creation, and Atlas fails live readiness without explicit attestation.
- Every HTTP endpoint is GET-only.
- Paper and shadow sampling run continuously by default. Explicit environment
  flags provide emergency brakes when either measurement path must be quarantined.
- Existing paper positions are marked and closed only in the virtual ledger.
- The dormant execution policy decodes supported V2 router calldata and rejects foreign recipients, unapproved paths, zero minimum output, long deadlines, inconsistent spend declarations, and native value. ERC-20 approval validation permits only the exact planned amount to an approved router; unlimited allowances fail closed. Neither boundary is connected to a signer.

MoonPay CLI supports Robinhood Chain swaps, but its current high-level swap command builds routes and approvals through swaps.xyz before signing locally. Atlas does not use that command for execution because it cannot yet independently validate the final unsigned transaction against this policy. MoonPay remains a candidate quote/execution adapter only after that boundary is separable.

## Measurement model

Swap activity is stored as timestamped per-block counts. Signals compare a 60-second window with a rate-normalized five-minute baseline; pool age is measured in elapsed time rather than block count.

Candidate safety is measured at the paper book's actual intended notional. V2 and bounded same-tick V3 quotes determine acquired quantity, execution price, sell proceeds, fees, and price impact. These fields are explicitly named `buyMathOk` and `sellMathOk`: they are AMM arithmetic, not a honeypot or transfer-tax simulation. Any future live-entry policy must set `requireSellProbe`; without independently supplied sell evidence, the risk gate fails closed.

Shadow evaluation uses one five-minute horizon and one sample per rule/pool episode. Confirmed zero liquidity is recorded as a total loss; genuinely unavailable measurements are censored and reported. Promotion requires at least 20 unique pools, a positive median, and a positive pool-cluster bootstrap lower confidence bound. Promotion remains advisory.

## Persistence

Mount a Railway volume at `/data` and set:

```sh
STATE_FILE=/data/observer-state.json
```

State is written atomically. A missing file starts cleanly. Corrupt, unsupported, or unreadable state blocks paper automation and all subsequent writes while leaving scanner health visible, preserving the original file for recovery.

Paper and shadow evidence is also appended to a SHA-256 chained JSONL journal
at `/data/evidence/<epoch>.jsonl`. Journal corruption, unavailability, or an
unconfigured journal blocks automation and live readiness. The immutable chain
is exposed read-only at `/api/evidence`; the mutable state file remains a cache.

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
- `/api/evidence`

## RPC reliability

All JSON-RPC calls pass through a serialized scheduler. The configured poll interval is 30 seconds when caught up, while recovery work reschedules after one second; observed cadence is therefore workload-dependent and is published in health metrics. The paper/shadow evaluator is eligible to run every 10 seconds while the scanner is ready. Block-range scanning captures intervening events, and any recovery-skipped blocks are published as a data-quality signal. `RPC_FALLBACK_URLS` accepts comma- or whitespace-separated backup providers; Atlas cools down and bypasses endpoints that time out or return HTTP 401/403/408/429/5xx. Health output reports only endpoint indexes and counts so provider API keys cannot leak.

## Reuse policy

- `viem` (MIT) supplies ABI decoding and EVM primitives.
- No GPL/AGPL or unlicensed trading-bot code is copied into this repository.
