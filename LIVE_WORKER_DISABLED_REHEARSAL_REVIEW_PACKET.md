# Atlas — Disabled Live Worker Rehearsal Review Packet

## Scope and safety boundary

This change adds a local-only rehearsal command and restart matrix. It does not deploy,
fund, configure, or activate the live worker. `npm run rehearse:live-worker` refuses to
run if either live activation flag is true or if any signing/verification/attestation
private material is present. Its child test process receives only `PATH` and `NODE_PATH`.
All transactions are signed by a deterministic local test account and every provider,
receipt, candidate, inspection, and preflight response is an in-process stub.

Production `main` remains `PAPER_ONLY`; `index.js` and the worker runtime are unchanged.

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

The scenario uses the production `ExecutionLifecycle`, `LiveExecutionWorker`, intent
builders, calldata validators, position ledger, execution journal, nonce lane, spend
ledger, evidence journal, and checkpoint validation. It finishes with no open position,
both buy and sell intent IDs durably processed, exact 190 base units acquired, exact 75
WETH units settled, and a healthy evidence chain.

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

## Validation

`npm run rehearse:live-worker` passed at `2026-09-15T19:17:14.151Z` and printed a
structured `LOCAL_STUBS_ONLY` report covering all five boundaries. `npm run check`,
`npm run check:live-worker`, `npm test`, and `git diff --check` also pass on the
dependency-complete runner: 342/342 tests.

The requested review decision is whether this rehearsal evidence is adequate to proceed
to the separately authorized real-organization Turnkey behavioral matrix. It is not a
request to deploy, fund, or arm the worker.
