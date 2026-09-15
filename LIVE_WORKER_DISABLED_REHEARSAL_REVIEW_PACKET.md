# Atlas — Disabled Live Worker Rehearsal Review Packet (revision 2)

## Scope and safety boundary

This change adds a local-only rehearsal command and restart matrix. It does not deploy,
fund, configure, or activate the live worker. `npm run rehearse:live-worker` refuses to
run if either live activation flag is true or if any signing/verification/attestation
private material is present. Its child test process receives only `PATH` and `NODE_PATH`;
the report therefore states `networkConfigurationWithheld`, not that OS networking is
mechanically disabled.
All transactions are signed by a deterministic local test account and every provider,
receipt, candidate, inspection, and preflight response is an in-process stub.

Production `main` remains `PAPER_ONLY`; `index.js` and the worker runtime are unchanged.
The only production-module correction in revision 2 is the exact intent-ID binding
described below.

## Rehearsed path

The uninterrupted scenario executes candidate → buy → receipt-derived position →
residual allowance → zero reset → exact approval → stop-triggered full sell →
receipt-derived WETH settlement.

The restart scenario uses `openLiveExecutionStore` with real temporary state and evidence
files. At each boundary it discards the previous store objects and restores from the
hash-chained checkpoint before continuing:

1. confirmed buy receipt before position open;
2. durable exact-unit position before allowance handling;
3. confirmed zero-reset before exact approval;
4. confirmed exact approval and durable exit request before sell submission;
5. confirmed sell receipt before position close.

The restart scenario now drives allowance selection, reset, exact approval, stop
evaluation, exit request, and sell through `LiveExecutionWorker.runOnce()`. Direct calls
remain only where needed to create the initial durable buy receipt and to invoke
reconciliation at the two receipt/position crash boundaries. It uses the production
execution lifecycle, intent builders, calldata validators, position ledger, execution
journal, nonce lane, spend ledger, evidence journal, and checkpoint validation. It
finishes with no open position,
both buy and sell intent IDs durably processed, exact 190 base units acquired, exact 75
WETH units settled, and a healthy evidence chain.

## Revision-1 findings and rehearsal discovery

- **R-1 resolved:** the restart matrix now uses `runOnce()` for every worker decision and
  proves that restoring after the zero reset selects the exact approval rather than
  issuing another reset.
- **R-2 resolved:** a composition test uses the real `assessLiveExitPreflight` with an
  off-by-one allowance and proves the lifecycle rejects before its signer is called.
- **R-3 resolved:** the report now makes the narrower, verifiable claim
  `networkConfigurationWithheld: true` and parses/records child pass and fail counts.
- **R-4 resolved:** a reverted sell remains exit-requested until the following cycle;
  reconciliation cancels it, and a fresh successful retry closes the position.
- **D-1 discovered and fixed:** that reverted-sell rehearsal exposed that buy/sell intent
  IDs did not include the router deadline even though the deadline changes calldata. A
  retry built at a new deadline could therefore be rejected as a duplicate if the pinned
  block and quote were unchanged. Both buy and sell identities now include the exact
  deadline, with a regression test proving distinct calldata deadlines produce distinct
  IDs. This changes no policy, amount, recipient, selector, or activation setting.

## Review questions

1. Can the rehearsal command load a real signing secret, inherit either activation flag,
   contact a real RPC/Turnkey endpoint, or modify production state?
2. Does reopening the real store after every named boundary meaningfully model a process
   crash, rather than retaining correctness in an in-memory fixture?
3. Does the residual allowance actually execute `approve(router, 0)` before the distinct
   exact-unit approval on a later lifecycle?
4. Are the buy and sell positions reconstructed only from durable signed payloads and
   receipt logs after restart?
5. Does a confirmed sell remain recoverable into a closed position when the process stops
   before position settlement?
6. Are state/evidence divergence, nonce ownership, and mutation counts checked by the same
   production store code used by the worker?
7. Does the real preflight refusal prevent signing when allowance differs by one unit?
8. Can a reverted sell be cancelled and retried with a deadline-bound fresh intent ID?

## Validation

`npm run rehearse:live-worker` passed at `2026-09-15T19:34:04.170Z` and printed a
structured `LOCAL_STUBS_ONLY` report with 4 pass / 0 fail across the uninterrupted,
restart, real-preflight-refusal, and reverted-sell scenarios. `npm run check`,
`npm run check:live-worker`, `npm test`, and `git diff --check` also pass on the
dependency-complete runner: 345/345 tests.

The requested review decision is whether this rehearsal evidence is adequate to proceed
to the separately authorized real-organization Turnkey behavioral matrix. It is not a
request to deploy, fund, or arm the worker.
