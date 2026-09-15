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

The micro-mainnet review boundary uses a second Turnkey API user and never
repurposes the read-only observer credential. Configuration requires an exact
mode plus enable flag, a wallet-bound confirmation string, an explicit router
allowlist, and integer WETH, gas, and fee caps. Atlas also requires that the
signing organization and wallet match the independently verified observer
wallet while the signing API public key differs.

The signing private key must never be placed in the Railway web service. The
runtime refuses to start if a signing-verification key or attestation private
key is present. Policy metadata is verified only by the isolated
`npm run verify:signing` command,
using `TURNKEY_SIGNING_VERIFY_API_PRIVATE_KEY` for that process. The command can
write a P-256-signed, expiring attestation bound to the entire public execution
configuration and a recent behavioral-matrix summary. Set
`TURNKEY_SIGNING_BEHAVIORAL_MATRIX_FILE` to a private JSON result containing
`runAt`, structured buy/sell/approval successes, and the twelve named denial
cases. The verifier fetches every activity from Turnkey and checks organization,
signing-user vote, wallet, status, type, policy-denial failure, and the decoded
transaction before issuing anything. Successful activities are checked from
their signed bytes. Every denied activity's unsigned transaction must differ
from an otherwise allowed request in exactly its named way; relabelled denials
and requests with multiple defects are rejected. Turnkey transaction payloads
are validated as even-length hex and normalized to a `0x` prefix before parsing,
so either documented response form is accepted without relaxing validation.
Policy-denial recognition is
temporarily conservative text matching over Turnkey's failure object; the
first real-organization ceremony must capture and pin the exact structured
failure field before execution is connected. The signed claims contain only
their counts, timestamp, and SHA-256 digest. The
web runtime holds only the attestation public key, reads the attestation file,
and uses the observer credential to re-check the signing user and exact policy
set hourly. Expiry, signature failure, missing behavioral evidence,
configuration drift, or policy drift closes activation. The verifier requires different observer and
signing users and exactly three applicable ALLOW policies: buy swap, sell swap,
and approval. Buy and sell policies bind
chain 4663, zero native value, bounded EIP-1559 gas fields, the allowlisted V2
routers, `swapExactTokensForTokens`, a two-address path, and Atlas as recipient;
the buy additionally caps WETH input and begins with WETH, while the sell ends
with WETH. The approval policy binds the ERC-20 `approve` selector and router
spender. Application validation must bind the approval amount to the exact
current intent and continues to reject unlimited approval. Router Smart
Contract Interfaces are required for named swap arguments; the real Turnkey
organization must still pass the documented allowed/denied behavioral matrix.
Matrix age is deliberately checked again by the runtime, so early micro-mainnet
operation requires a newly executed matrix at least once every 24 hours. This
is an operator safety ceremony, not unattended background credential use.

Every future execution lifecycle must receive an explicit asynchronous
preflight. It runs after static policy/calldata validation but before spend or
nonce reservation, and rejection or error stops the intent without touching the
provider. Rejections are written as final, coded execution-journal evidence and
are not counted as pending transactions. The dormant journal semantics are
ready, but persistence still must be wired through the state/evidence checkpoint
before any submission path is connected; public evidence consumers must accept
final `rejected` execution records. When the submission path is eventually connected, this preflight must
re-read Turnkey policy state and wallet balances for every intent; hourly status
revalidation alone is not sufficient.

The dormant execution journal, nonce lane, and daily spend ledger are included
in the atomic state checkpoint. Every mutation first appends a typed record to
the hash-chained evidence journal and then fsyncs and atomically replaces state;
a failure rolls the component's in-memory mutation back and blocks on checkpoint
divergence after a crash. Restore reconciles evidence counts, intent ownership,
and nonce ownership before readiness. Pending activation state is derived from
the restored execution journal, never a literal. A finalized journal record
with a leftover nonce reservation is safely finalized during restore. Because
execution evidence shares the cohort journal, a paper epoch must not be bumped
while execution records exist without an explicit reviewed migration.

Before the first live execution, the release runbook must include this paper
epoch migration rule: first force `PAPER_ONLY`, stop new intents, and require
zero pending executions; then archive the state file and its matching evidence
journal together with the terminal sequence and hash. A reviewed migration
tool must verify that pair and write an execution-archive manifest before it
starts a new paper epoch with empty execution counters and a new evidence file.
Never hand-edit either checkpoint, never reuse the old evidence file, and abort
the epoch bump on any pending intent or reconciliation mismatch. Until that
tool exists, any non-empty execution history prohibits a paper epoch bump.

The branch includes a dormant Turnkey-backed viem provider that obtains the
pending nonce, estimates gas, rejects gas or EIP-1559 fees above configured
caps, signs, checks the signed hash, and broadcasts once. The lifecycle records
the signed payload and gas fields before broadcast. It can escalate an old
missing receipt to manual review and offers an operator-only method that may
rebroadcast only the identical stored bytes. It is deliberately not connected
to candidate selection or any HTTP endpoint. Public status reports
`boundary: review-only-disconnected` and activation fails with
`execution-submission-path-not-connected`; adding credentials cannot cause a
transaction. The policy prevents direct asset transfer out, but it cannot stop a
compromised signer from trading into a hostile pool at a negligible minimum
output. The compromise loss bound is therefore the WETH funded in the signing
wallet, not the per-transaction limit. Activation requires a freshly measured
wallet balance no greater than the daily cap; live execution must re-check that
balance immediately before each intent and funding must remain just-in-time.

Exact approval orchestration, receipt-aware execution recovery, native-gas funding checks,
post-buy sell re-probing, the behavioral policy matrix, and the final
strategy-to-intent binding remain required before that connection can be
reviewed.

MoonPay CLI supports Robinhood Chain swaps, but its current high-level swap command builds routes and approvals through swaps.xyz before signing locally. Atlas does not use that command for execution because it cannot yet independently validate the final unsigned transaction against this policy. MoonPay remains a candidate quote/execution adapter only after that boundary is separable.

## Measurement model

Swap activity is stored as timestamped per-block counts. Signals compare a 60-second window with a rate-normalized five-minute baseline; pool age is measured in elapsed time rather than block count.

Candidate safety is measured at the paper book's actual intended notional. V2 and bounded same-tick V3 quotes determine acquired quantity, execution price, sell proceeds, fees, and price impact. These fields are explicitly named `buyMathOk` and `sellMathOk`: they are AMM arithmetic, not a honeypot or transfer-tax simulation. Any future live-entry policy must set `requireSellProbe`; without independently supplied sell evidence, the risk gate fails closed.

The independent V2 sell probe requires two matching, read-only simulations for
the same pool. First, it uses a recent observed sell transaction to identify a
real token holder and an allowlisted router, verifies the holder's intended-size
balance and allowance, and re-simulates that route. Second, it runs the same
bounded sell from Atlas's configured wallet address using temporary `eth_call`
state overrides for the token balance and allowance mappings. The overrides
exist only inside the RPC simulation; Atlas never signs, broadcasts, approves,
or changes chain state. This second proof prevents a privileged recent seller
from serving as the sole evidence for a restricted token. A stale seller,
foreign router, unresolved storage layout, unsupported override, revert, or
malformed router output fails closed. Readiness clears only while both proofs
remain fresh for one candidate; it does not claim that a future transaction is
guaranteed to execute.

At startup Atlas performs one state-override canary against the canonical L2
WETH balance mapping (slot 51 in the Arbitrum `aeWETH` / OpenZeppelin 4.8.3
layout used by the chain). If the provider cannot echo the override, self-simulation is
disabled for that process and readiness reports
`sell-probe-state-override-unsupported`. Non-standard token layouts are cached
as negative discoveries for one hour by default. Probe calls use a dedicated
scheduler and transport, run asynchronously only after a paper cycle finishes,
and publish their failure counters separately; probe discovery therefore cannot
delay position marks or contaminate the scanner's RPC-failure metric.

The V6 qualifying paper policy risks 5% of remaining cash per entry, stops at
an 8% executable loss, begins trailing after a 10% gain, takes profit at 35%,
and permits at most three entries per pool per epoch with a 15-minute cooldown.
Exit impact of 20% or more is recorded as `liquidity-collapse`; the executable
loss remains fully included in P&L. The entry circuit and live-readiness gate
share one 10% maximum-drawdown constant. Qualification also requires 20 unique
paper pools, preventing repeated episodes in a few pools from masquerading as
an independent 50-trade cohort.

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
Each append is flushed with `fsync`; state checkpoints bind the journal sequence,
terminal hash, and paper-record count to the ledger. A mismatch blocks startup.
Streaming clients should discard an incomplete trailing line if they read while
an append is in progress.

If a crash occurs after a journal append but before its state checkpoint, preserve
both files and do not hand-edit either one. The epoch is quarantined by the
checkpoint mismatch. Archive the journal and state for review, bump the epoch
identifier, and begin a new clean cohort; automatic replay is intentionally not
enabled yet.

Changing `PAPER_INITIAL_CASH` or `PAPER_WETH_INITIAL_CASH` during an epoch will
trip the ledger invariant on restart. Treat initial cash as part of the frozen
epoch configuration.

Gas constants are accepted as qualifying evidence only after Atlas reads the
receipt for `PAPER_GAS_MEASUREMENT_TX`, verifies a successful recent transaction
to a router in `PAPER_V2_ROUTER_ADDRESSES`, includes the receipt's L1 component,
and confirms `PAPER_WETH_GAS_PER_SIDE` is no lower than the observed cost. The
public status reports the derived cost but deliberately omits the transaction
hash. Until every check passes, the entry gate stays closed.
Verification is repeated hourly by default; any later failure closes the entry
gate. Public status includes `lastVerifiedAt`, but not the router or block.

Turnkey read-only verification requires that the API user is outside the root
quorum, owns the configured API key, has zero applicable `EFFECT_ALLOW`
policies, and is covered by the configured `EFFECT_DENY` policy. Conditions are
not interpreted as a safety allowlist: any applicable ALLOW fails closed.

For the future signing attestation, generate a separate P-256 operator keypair.
Provide its base64-encoded private PEM only to the isolated
`npm run verify:signing` process through
`TURNKEY_SIGNING_ATTESTATION_PRIVATE_KEY_PEM_B64`. Give the web runtime only the
base64-encoded public PEM and the generated attestation file. The default
attestation lifetime is six hours and the hard maximum is 24 hours. The
one-shot Turnkey signing API private key and the attestation private key must
never be added to Railway service variables.

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

All JSON-RPC calls pass through a serialized scheduler. The configured poll interval is 30 seconds when caught up, while recovery work reschedules after one second; observed cadence is therefore workload-dependent and is published in health metrics. Full paper and shadow evaluation is eligible to run every 10 seconds only while the scanner is synchronized. Recovery is lossless and bounded: each poll scans the next contiguous range of up to 100 blocks and never moves the cursor past an unseen block. If positions are open, Atlas runs an exit-only paper cycle between recovery batches using current executable reserve quotes; entries and shadow recording remain paused. Recovery exits are labelled `audit.duringRecovery: true`. `/health` publishes remaining blocks, recovery start/completion times, duration, and the separate recovery-exit counters. `recoverySkippedBlocks` remains a cohort-integrity invariant and must stay zero. `RPC_FALLBACK_URLS` accepts comma- or whitespace-separated backup providers; Atlas cools down and bypasses endpoints that time out or return HTTP 401/403/408/429/5xx. Health output reports only endpoint indexes and counts so provider API keys cannot leak.

## Reuse policy

- `viem` (MIT) supplies ABI decoding and EVM primitives.
- No GPL/AGPL or unlicensed trading-bot code is copied into this repository.
