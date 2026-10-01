# Paper input renewal — offline repair, October 1

The production snapshot on October 1 showed `gas-measurement-stale`, a
September 14 gas reference, no sell-probe attempts since the September 25
restart, and zero entries in the opportunity cohort. The scanner was still
running after the attempted pause. Deployment removal subsequently stopped it.

## Changes

- Refresh gas evidence from recent V2 WETH-pair swaps already observed by the
  scanner. Selection is independent of entry readiness so an expired gas input
  cannot prevent discovering its replacement.
- Retain receipt success, router allowlist, block age, L1 fee accounting, and
  configured gas floor checks. A higher measured cost blocks entry rather than
  silently raising the configured assumption or choosing a cheaper sample.
- Limit a refresh to three distinct receipt checks and up to three block reads.
  Retry blocked renewal at most once every five minutes; healthy evidence uses
  the existing verification interval (one hour by default). Concurrent timer
  and paper-cycle requests share one operation. Transport retries/failovers can
  add physical requests; this is not an account-wide spending cap.
- Expose renewal state under `gasMeasurement.renewal` and sell-test selection
  counts under `sellProbe.selection`, including current gas failures.

## Verification and limits

Run `node --test gas-refresh.test.js gas-measurement.test.js
sell-probe-targets.test.js paper-lifecycle-wiring.test.js` on one line, followed
by `node --check index.js`.

The offline fixture validates receipt renewal and feeds successful sell evidence
through the existing opportunity risk gate, lifecycle sizing, and paper ledger.
It proves that those inputs can permit a simulated position; it is not a real
market replay, a live sell simulation, or proof of profitability. No RPC calls,
signing, or hosted application startup are used by these tests.

No signal/risk thresholds or execution connections are changed. Keep all
deployments stopped during review. New market data and fresh sell simulations
are still required to establish that real opportunities qualify.

## Opportunity accounting and bounded trial

Every evaluated entry decision now appends a `paper-opportunity-evaluation`
event to the existing hash-chained evidence journal. Checkpoints retain counts
by cohort and exact joint rejection combinations, and restore verifies the
evaluation total against the journal. The previous last-50 display is no longer
the only record for new decisions. This cannot reconstruct old decisions.

`strategyQualified` runs the existing entry planner with only the gas/sell-proof
blockers excluded, still checking sizing and portfolio limits. It is research
classification only and never authorizes an order. `evidenceOnly` further
requires that no other rejection reason was recorded. `approved` means the
planner approved; only a separate cohort `open` event proves an actual paper
entry. Each cohort/pool has one episode until qualification is lost or more
than five minutes pass without an observation. Counts are per cohort, not
deduplicated market-wide trades. Mid-price movement during an episode is
recorded separately from any hypothetical executable return; later unobserved
prices and profitable missed trades are not inferred.

Both observer RPC transports share a durable request ledger at
`${STATE_FILE}.paper-trial.json`. Defaults are 10,000 physical attempts, two
hours total, and 30 minutes without a new persisted paper entry. The first
limit reached prevents further requests and entries; the status server stays
available and reports `PAPER_TRIAL_HALTED`. Already-sent requests may finish.
Open simulated positions are frozen, not closed at invented prices; their
outcomes are incomplete until separately resolved.

Limits can be configured with `PAPER_TRIAL_MAX_RPC_REQUESTS`,
`PAPER_TRIAL_MAX_DURATION_MS`, and `PAPER_TRIAL_NO_PROGRESS_MS`. Checkpoints and
time windows survive restart. No automatic reset is provided. Preserve the
completed ledger for review before explicitly provisioning a new trial.
Startup requires persistent state; an invalid or unwritable budget fails closed.

This is a per-observer request cap, not an Alchemy-dollar or compute-unit cap,
and not a Railway container shutdown. Only one observer replica may own the
files; do not restart the auxiliary scanners, which do not use this ledger.
The live worker is not connected or enabled by these changes. Rate-limit and
scan-efficiency work may still be needed before a trial produces enough data.

Focused offline verification also includes `paper-opportunities.test.js`,
`paper-trial-budget.test.js`, `rpc-transport.test.js`, and
`evidence-checkpoint.test.js`.

## Application startup verification

Dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund`;
the existing complete suite passed 517 tests. `paper-startup.test.js` also
launches the real observer entry point in a temporary directory with an explicit
credential-free environment and a preload that replaces all child-process
fetches with mock RPC responses. It verifies exactly three physical attempts,
paused entries at exhaustion, persistence across shutdown, and zero RPC attempts
after restart while the status endpoint remains available. It neither contacts
Alchemy nor starts a Railway deployment. Run with
`node --test paper-startup.test.js`.

Do not run `node index.js` directly as an offline check: without the test preload,
startup intentionally starts network polling. This smoke test contains no market
opportunities and does not establish actual sell-probe success or paper returns.
