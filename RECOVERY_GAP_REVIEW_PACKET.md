# Atlas V6b — Lossless Recovery Review Packet (revision 2)

## Review target

- Repository: `lexmcgregor97-del/Robinhood-chain---observer`
- Branch: `fix/v6-lossless-recovery`
- Baseline: `0e11d0f` (peer-reviewed dual sell-path probe deployment)
- Proposed epoch: `2026-09-15-paper-v6b-lossless-recovery`
- Intended deployment mode: `PAPER_ONLY`

Do not recommend live trading from this review. The requested decision is whether
the scanner can recover without omitting chain data and whether the invalid V6
paper cohort is isolated correctly.

## Production finding

The V6 deployment began a paper cohort and recorded:

- 8 closed trades, 0 open
- 3 unique paper pools
- expectancy: `+0.0006685582 WETH/trade`
- maximum marked drawdown: `2.0421%`
- measurement failures: 0
- evidence journal: healthy
- recovery-skipped blocks: **8**

The eight skipped blocks predated sell-probe commit `0e11d0f` and were restored
from the persistent V6 state. The deployment did not create them. A mid-run poll
fell 308 blocks behind; the old policy advanced the cursor by eight blocks and
then scanned only the newest 300. Readiness correctly reported
`paper-recovery-gaps-present`, permanently invalidating the cohort.

No V6 trade is deleted or reclassified. The V6 state and journal remain evidence
of a failed cohort and are archived by the normal epoch-migration path.

## Proposed change

1. Replace cursor jumping with `planLosslessRecovery()`.
2. Scan only the next contiguous range from `cursor + 1`.
3. Bound each recovery poll to 100 blocks so exit management is interleaved at
   roughly the existing paper-cycle cadence even on the current 10-block log
   query tier.
4. When more blocks remain, keep the scanner and paper evaluator not-ready and
   retry after one second.
5. Never increment or manufacture a skip: `recoverySkippedBlocks` must remain
   zero for the new epoch.
6. Bump only the paper epoch identifier to
   `2026-09-15-paper-v6b-lossless-recovery`, archiving the invalid V6 books and
   starting a new evidence journal.
7. When positions are open during recovery, run only the mark/exit portion of
   the paper cycle between contiguous scan batches. Do not run entries, candidate
   selection, shadow resolve/record, or the sell probe.
8. Label any resulting close `audit.duringRecovery: true` and publish separate
   recovery-exit cycle and exit counters.
9. Publish current remaining blocks, active-since time, and the timestamp and
   duration of the last completed catch-up.

The V6 signal, entry, sizing, exit, cooldown, diversity, drawdown, gas, evidence,
Turnkey, and dual sell-probe rules are unchanged.

## Failure behavior

- An RPC or log-query failure leaves the cursor at the last completed 500-block
  chunk and fails the poll. The next poll resumes at the next unseen block.
- A lag above 100 blocks is processed across multiple contiguous polls. No
  block is discarded merely to restore availability.
- New entries, candidate selection, shadow evaluation, and sell probing remain
  paused while `cursor < latestBlock`. Existing positions continue receiving
  executable marks and exits. Those closes stay in P&L and are explicitly
  identified as recovery-time observations.
- Initial bootstrap still starts at the configured 20,000-block historical
  window before any paper epoch activity exists. This patch concerns recovery
  from an already persisted cursor.

## Validation

`recovery-policy.test.js` pins the production failure and the replacement:

- a 308-block lag scans blocks `cursor + 1` through `latest` with zero skips;
- a 50,000-block lag is split into contiguous bounded ranges with no holes;
- a caught-up cursor schedules no scan;
- invalid cursor and limit inputs fail closed.
- an unsynchronized scanner selects `exits-only` only when a position is open;
  otherwise it remains paused, while a synchronized scanner selects the full
  paper cycle.

Local validation with locked dependencies: `npm run check` passes and `npm test`
passes **191/191**.

Run:

```sh
npm ci
npm run check
npm test
```

## Requested review

1. Can any runtime or restored recovery path advance `metrics.cursor` past an
   unseen block?
2. Does a partial `scanRange` failure leave the cursor at the last fully
   processed chunk so retry cannot create a hole?
3. Can paper or shadow evaluation run while a bounded recovery has remaining
   blocks?
4. Does the 100-block batch bound interleave position management without
   weakening the zero-gap cohort invariant?
5. Does the epoch bump archive V6, reset paper automation (including the eight
   gaps), and start a distinct journal without contaminating V6b?
6. Did any trading, readiness, evidence, Turnkey, gas, or sell-probe gate weaken?
7. Can the recovery path reach candidate selection, entries, shadow recording,
   or the sell probe, or does it return immediately after marks/exits?
8. Are recovery-time closes labelled and counted without excluding or
   reclassifying their P&L?

Please provide separate Go/No-go verdicts for:

- merge to `main`
- deploy in `PAPER_ONLY`
- begin the fresh V6b epoch
- enable micro-mainnet (expected to remain No-go)
