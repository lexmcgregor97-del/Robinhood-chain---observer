# Atlas — Final Live Wiring Review Packet (revision 2)

## Status

This revision adds a private Railway worker entry point and entry-side composition path.
The public observer remains incapable of signing. Both worker activation flags default false;
in that state the process cannot touch RPC, durable storage, Turnkey, or submission.
The worker cannot be armed: `exitPathConnected` is hard-coded false and requesting
connection adds `live-worker-exit-path-not-connected` to configuration failures.

## Review surface

Revision 2 closes the revision-1 findings without making the entry-only worker armable:

- `recover-executions.js` now accepts the worker's state/evidence schema through
  `EXECUTION_RECOVERY_STORE=live-worker`; validation, concurrent-writer detection,
  recovery, manual resolution, restoration, and identical rebroadcast operate on the
  selected store. The worker checks the same exclusive recovery lock at startup,
  before each cycle, and before every evidence mutation.
- The observer's worker-only candidate and readiness endpoints require a 32+ character
  bearer token. The private worker additionally requires an exact hostname pin and
  sends the credential only to that HTTPS host.
- Chain inspection reads the head a second time after the pinned snapshot and preflight
  checks both block lag and the chain block's own timestamp against bounded freshness.
- Swap fee selection is derived from the independently verified factory address, not
  from the observer's DEX label.
- Persistent cycle failures now use bounded exponential backoff and halt at a required
  failure ceiling with a redacted failure class.
- The worker re-checks the second strategy verdict and refuses when it is no longer
  approved.

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
- `live-worker-adapters.js` requires an authenticated, host-pinned fresh healthy paper
  cohort and current signed attestation status from the observer, probes the signing policy directly with the private
  worker credential, and runs the existing dual-path sell simulation from fresh data.
- `live-worker-config.js` adds a second exact activation ceremony specific to connecting
  this private submission path. Complete micro-mainnet configuration alone leaves both
  worker connection and automatic submission disabled.
- `live-worker-runtime.js` orders both ceremonies, sealed-key presence, chain identity,
  state/evidence restoration, live signing-policy verification, account creation,
  lifecycle recovery, and only then exposes the composed worker.
- `run-live-worker.js` is the private Railway command. It serializes cycles, redacts
  caught errors, remains inert when disabled, backs off persistent failures, and halts
  at the configured failure ceiling or on termination.

## Deliberately disconnected

- The entry point exists, but both connection and automatic submission default false.
- `index.js` still reports its own public submission path as disconnected and cannot
  load the worker signing key.
- No automated approval transaction; the buy requires a sufficient allowance no
  greater than the configured approval cap.
- This revision is entry-only. It has no position ledger, sell-intent builder, or exit
  triggers. The hard-coded exit-path gate makes both activation flags unusable until
  those components are implemented and reviewed.

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

## Validation

`npm run check`, `npm run check:live-worker`, `npm test`, and `git diff --check` pass;
the dependency-complete test run is 320/320.

Deployment and both activation flags remain out of scope. Acceptance of this revision
permits only merging disconnected scaffolding; the exit path remains a separate blocker.
