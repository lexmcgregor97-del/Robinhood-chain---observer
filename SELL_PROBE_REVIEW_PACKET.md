# Atlas V6 — Dual Sell-Path Probe Verification Review

## Review target

- Repository: `lexmcgregor97-del/Robinhood-chain---observer`
- Branch: `fix/sell-path-probe`
- Baseline: V6 risk calibration commit
- Intended deployment mode: `PAPER_ONLY`
- Paper epoch: unchanged (`2026-09-15-paper-v6-risk-calibration`)

This patch does not connect the dormant execution lifecycle to a signer and does
not alter paper entry sizing, signals, exits, P&L, journaling, or epoch identity.
Revision 2 responds to the first review's methodological finding: an observed
seller may be privileged and cannot be the sole evidence. Readiness now requires
both the observed-holder simulation and an independent Atlas-address simulation
to pass for the same pool while fresh.

## What the probe proves

For a V2 candidate, Atlas:

1. Requires a recent observed swap in the sell direction (base token to approved
   quote token).
2. Fetches that transaction and requires its destination to be in the existing
   `PAPER_V2_ROUTER_ADDRESSES` allowlist.
3. Uses the transaction sender only as an impersonated `eth_call` source; no key
   for that account is known or required.
4. Verifies the observed seller currently has at least the exact base-token amount
   Atlas would acquire at its intended entry size.
5. Verifies that seller's allowance to the observed allowlisted router covers the
   exact amount.
6. Recomputes expected V2 output from current reserves and applies a non-zero,
   configurable slippage floor (default 5%).
7. Encodes `swapExactTokensForTokens`, then passes it through Atlas's existing
   calldata validator: exact spend, approved path, correct recipient, zero native
   value, non-zero minimum output, and a 60-second deadline.
8. Executes only `eth_call` and validates the router-returned input/output array.
9. Discovers the base token's balance and allowance mapping slots over a bounded
   range by applying sentinel values in temporary RPC state overrides and reading
   `balanceOf(Atlas)` / `allowance(Atlas, router)` until each value echoes.
10. Applies the exact intended balance and allowance only inside a second
    `eth_call`, changes the sender and recipient to Atlas's configured wallet,
    executes the same validated router sell, and verifies its returned amounts.

The second method specifically prevents a deployer, whitelisted wallet, or launch
bundle seller from satisfying readiness on Atlas's behalf. It exercises token
restrictions against Atlas's address without holding the token, approving a
router, signing, or broadcasting. Unsupported state overrides and non-standard
or undiscoverable storage layouts fail closed.

A passing result is candidate-specific and expires after 15 minutes by default.
The global readiness bit requires the most recent scheduled attempt to pass and
the last success to remain fresh. Future live entry must still require the
candidate-specific `marketSafety.sellProbe.passed`; the probe does not guarantee
that a later submitted transaction will execute.

## Fail-closed cases

- missing or invalid router allowlist
- non-V2 candidate
- buy-side or stale observed transaction
- invalid holder or router address
- observed router outside the allowlist
- malformed reserves or exact intended amount
- insufficient observed-holder balance or allowance
- missing Atlas wallet address
- unresolved balance or allowance storage slot within the configured bound
- unsupported RPC state overrides
- Atlas-address router revert or malformed output
- zero minimum output or locally rejected calldata
- RPC failure, token-call failure, router revert, or malformed router output
- expired passing evidence

Errors are categorized; RPC/provider error text, holder address, router address,
and transaction hash are not returned in public probe status.

## Runtime/load boundary

- The probe reuses the already configured V2 router allowlist.
- It runs at most once every five minutes by default.
- It considers at most three recent sell-side candidates per attempt.
- Storage slots are cached in memory per token after bounded discovery; stale
  per-pool probe records are evicted on each scheduled attempt.
- All RPC calls go through Atlas's existing serialized scheduler and transport.
- `/health` and `/api/paper` expose only readiness, timestamps, checked pool,
  method, maximum evidence age, and normalized failure categories.
- The endpoint handlers do not trigger a probe, preventing public request-driven
  RPC amplification.

## Validation

- `npm run check`: passes
- `npm test`: 183/183 passes with dependencies installed
- New tests cover configuration, exact bounded success, sell direction and age,
  allowlisted router, balance, allowance, router revert, Atlas state overrides,
  the privileged-seller gap, bounded slot failure, and public data hygiene.

## Requested review

1. Does requiring both methods close the prior survivorship/privileged-seller gap?
2. Are the standard Solidity balance and nested allowance storage keys derived
   correctly, and can a false slot match or stale cache produce a false pass?
3. Can the Atlas-address simulation pass without the RPC actually applying both
   state overrides to the router call?
4. Are address-scoped restrictions, fee-on-transfer behavior, max-transaction
   limits, and holder blacklists conservatively exercised against Atlas?
5. Are amount orientation, reserves, path, fee, slippage, deadline, and router
   return decoding correct for both quote-token orientations?
6. Can stale per-pool evidence or an old global success incorrectly clear
   `sell-probe-not-ready`?
7. Is the five-minute, three-candidate budget still safe with bounded first-use
   slot discovery and per-token caching?
8. Does the patch expose holder identity, router identity, transaction hashes,
   provider errors, credentials, or other unnecessary operational data?
9. Confirm that no signer, approval, broadcast, real-money path, or relaxed gate
   was introduced.

Please provide separate Go/No-go verdicts for merge, `PAPER_ONLY` deployment,
and whether this is sufficient to clear the generic sell-path readiness blocker.
Micro-mainnet should remain No-go until every other readiness gate and a qualifying
V6 cohort pass.
