# Atlas — Final Live Wiring Review Packet (revision 1)

## Status

This revision adds a private Railway worker entry point and complete composition path.
The public `index.js` remains unchanged. Both worker activation flags default false;
in that state the process cannot touch RPC, durable storage, Turnkey, or submission.

## Review surface

- `live-v2-intent.js` rebuilds an immutable exact-spend V2 buy from an observer hint
  plus an independently read pool snapshot.
- `live-v2-strategy.js` verifies the pair against the canonical factory and its exact
  `PairCreated` block, scans the pool's Swap logs itself, retrieves their block times,
  and independently derives signal velocity, AMM safety, price audit, and risk verdict.
- `live-execution-preflight.js` requires fresh readiness, signing-policy, sell-probe,
  pool, reserve, block, WETH/native balance, and bounded-allowance evidence.
- `live-chain-inspector.js` pins pool identity, reserves, wallet balances, and allowance
  reads to one exact block. Strategy, readiness, signing-policy, and sell-probe checks
  are independently invoked for the construction and preflight phases.
- `live-execution-store.js` gives the private worker its own atomic state file and
  hash-chained evidence journal, refusing startup if either side diverges.
- `live-execution-worker.js` strips observer-derived fields, permits one active cycle,
  blocks on any pending journal record, and retains its immutable plan only while the
  existing lifecycle performs the second inspection and submission.
- `live-worker-adapters.js` requires a fresh healthy paper cohort and current signed
  attestation from the observer, probes the signing policy directly with the private
  worker credential, and runs the existing dual-path sell simulation from fresh data.
- `live-worker-config.js` adds a second exact activation ceremony specific to connecting
  this private submission path. Complete micro-mainnet configuration alone leaves both
  worker connection and automatic submission disabled.
- `live-worker-runtime.js` orders both ceremonies, sealed-key presence, chain identity,
  state/evidence restoration, live signing-policy verification, account creation,
  lifecycle recovery, and only then exposes the composed worker.
- `run-live-worker.js` is the private Railway command. It serializes cycles, redacts
  caught errors, remains inert when disabled, and stops scheduling on termination.

## Deliberately disconnected

- The entry point exists, but both connection and automatic submission default false.
- `index.js` still reports its own public submission path as disconnected and cannot
  load the worker signing key.
- No automated approval transaction; the buy requires a sufficient allowance no
  greater than the configured approval cap.

## Adversarial review questions

1. Can either activation ceremony be bypassed or can the disabled worker touch secrets,
   RPC, storage, signing, or broadcasting?
2. Can observer-controlled candidate fields survive sanitization into calldata?
3. Are factory identity, creation event, Swap history, reserves, price audit, and the
   second strategy check independently bound to the intent?
4. Can stale readiness, a stale/widened Turnkey policy, failed sell simulation, low
   balances, excessive allowance, price movement, daily spend, gas, or fees still sign?
5. Does every crash boundary retain enough journal, evidence, and nonce ownership for
   the already-reviewed recovery commands?
6. Can more than one intent or cycle enter the signing path concurrently?

Deployment and both activation flags remain out of scope until this review is accepted.
