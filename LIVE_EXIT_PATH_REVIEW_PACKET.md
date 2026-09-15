# Atlas — Live Exit Path Review Packet (revision 1)

## Status

This branch completes the private worker's position and exit path. It does not deploy,
fund, or activate the worker. Both activation flags still default false and production
`main` remains `PAPER_ONLY`.

## Invariants introduced

- A confirmed buy becomes a live position only from the durable signed transaction and
  its validated receipt. Atlas sums base-token `Transfer` events to its wallet, requires
  one transfer source, independently proves that source is the configured V2 pool, and
  stores the exact integer base units. No floating-point reconstruction is used.
- Position mutations share the execution mutation serializer and the worker's
  evidence-first atomic checkpoint. Evidence counts cover open, mark, exit request,
  cancelled request, and close. Closed-position settlement remains in durable history.
- A crash after buy confirmation but before position persistence is repaired by scanning
  final journal records on the next cycle. Processed intent IDs prevent reopening a
  position after it has been closed.
- The router allowance for an exit is created automatically only when needed and equals
  the exact receipt-derived position units. The real-wallet approval is simulated at a
  pinned block before signing. A pre-buy approval simulation also proves the token accepts
  the required approval call before Atlas enters.
- Every holding cycle re-reads pinned balances, allowance, reserves, block head/timestamp,
  and factory identity. With exact allowance present, it simulates the complete sell from
  the actual wallet before evaluating or submitting an exit.
- Stop-loss, take-profit, trailing activation/drawdown, and maximum hold use the frozen V6
  paper-policy defaults and integer WETH output comparisons. A triggered exit spends the
  complete exact base-unit position through `[baseToken, WETH]` with a nonzero minimum,
  wallet recipient, 60-second-or-shorter deadline, EIP-1559 gas caps, direct Turnkey
  policy re-verification, and another pinned-block simulation immediately before signing.
- A confirmed sell closes the position only from receipt-derived WETH transfers. Reverted,
  rejected, never-signed, or pre-journal exit attempts return the position to `open` for a
  fresh block-bound retry; ambiguous or pending execution continues to block all cycles.
- Receipt recovery runs before the pending-record gate on every worker cycle, so a prior
  broadcast can progress to settlement without requiring a process restart; unresolved
  or manual-review records still block all new signing.
- Entry readiness can block new buys, but observer availability cannot block management
  of an existing position. Exit and exact-approval preflights depend on worker-owned RPC
  evidence, real-wallet simulation, gas balance, and direct signing-policy verification.

## Review surface

- New: `live-position-ledger.js`, `live-position-settlement.js`,
  `live-approval-intent.js`, `live-exit-policy.js`, `live-exit-preflight.js` and tests.
- Changed: `live-v2-intent.js`, `live-chain-inspector.js`, `live-v2-strategy.js`,
  `live-execution-worker.js`, `live-execution-store.js`, `live-worker-runtime.js`,
  `live-worker-config.js`, `execution-lifecycle.js`, `execution-checkpoint.js`,
  `recover-executions.js`, tests, README, `.env.example`, and `package.json`.

## Adversarial review questions

1. Can any quantity other than the exact confirmed base-token receipt units be approved
   or sold, including after restart, fee-on-transfer behavior, or a forged observer hint?
2. Can a confirmed buy be lost, reopened after close, or duplicated across any crash
   boundary between receipt, position open, approval, exit request, and sell settlement?
3. Can a rejected/reverted exit permanently strand the position, or can an ambiguous
   transaction be retried with different bytes or a reused nonce?
4. Does every live mark use independently verified current reserves and factory fee, and
   do the integer trigger comparisons exactly match the frozen V6 policy?
5. Can an observer outage, stale head, insufficient base/native balance, allowance drift,
   policy drift, simulation failure, price movement, or receipt mismatch still sign?
6. Does the exact approval introduce a broader token-spending capability than required,
   and is the pre-buy approval probe sufficient for the token compatibility claim?
7. Does the end-to-end test actually cover candidate → buy → receipt-derived position →
   exact approval → stop-triggered sell → WETH receipt settlement?
8. Does the live-store crash test prove the offline Turnkey restoration path remains
   reachable for a signing-requested record?

## Validation

`npm run check`, `npm run check:live-worker`, `npm test`, and `git diff --check` pass on
the dependency-complete runner: 333/333 tests.

Merge, deployment, funding, and activation remain separate decisions. The requested
review decision is whether this may merge as still-disabled exit-path scaffolding.
