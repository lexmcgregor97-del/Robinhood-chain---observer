# Atlas Micro-Mainnet Receipt Recovery — Review Packet (revision 2)

## Scope

Review branch `fix/micro-mainnet-recovery`, compared against receipt-recovery
revision 1 (`fc2f13156dbc4cebef672e5cb567061cc179cfd6`). Production remains V6b
`PAPER_ONLY`. This revision adds symmetric lock enforcement, independent
evidence-file revalidation, mandatory receipt identity, and receipt-block
evidence. The dormant lifecycle still delegates to the same engine.

## Safety boundary

The submission boundary is unchanged: no POST route, candidate-to-intent path,
runtime provider import, signer, or automatic broadcast exists. The recovery
command accepts no signing or attestation private material and makes only
`eth_chainId` and `eth_getTransactionReceipt` calls. It cannot sign, replace,
cancel, or broadcast a transaction.

## Recovery protocol

1. The operator scales the web runtime to zero, waits for a quiescent state
   checkpoint, and provides the exact offline confirmation string. The command
   rejects a state file younger than 60 seconds by default and takes an
   exclusive lock beside it.
   A web runtime started while that lock exists write-blocks itself at startup;
   every runtime evidence append checks again and write-blocks if recovery
   began after startup.
2. It initializes the epoch-specific evidence journal and validates sequence,
   terminal hash, paper ledger count, execution mutation counts, spend
   ownership, and nonce ownership before any RPC call or mutation.
3. It verifies `eth_chainId == 4663` and every pending record's chain ID before
   requesting receipts.
4. A confirmed or reverted receipt must have a recognized status, the exact
   requested transaction hash, and `from` equal to Atlas's configured wallet.
   A valid receipt block is also required. The final transition includes
   `receiptBlock`, is appended/fsynced, and the complete state is atomically
   checkpointed before nonce finalization is attempted. Nonce finalization is
   a second evidence-first checkpoint.
5. A recent missing receipt remains `still-pending`. After the bounded timeout
   it is durably labelled `manual-review`, which remains non-final and blocks
   activation. A reservation without durable signed bytes is labelled
   `manual-review` immediately. RPC exceptions, unknown statuses, and hash
   mismatches do not mutate state and return only fixed failure codes.
6. A crash after the final journal transition but before nonce cleanup leaves a
   mined final record with a pending lane. The next run finalizes only
   `confirmed`/`reverted` residue before processing other records.
7. Immediately before every durable mutation, the command re-reads the state
   checkpoint and independently initializes a new view of the evidence file.
   State `savedAt`, sequence and hash plus evidence-file sequence and terminal
   hash must all match its in-memory view. A concurrent writer blocks before
   append.

## Persistence and crash behavior

Every recovery mutation uses the same shared execution serializer and
evidence-first full-state checkpoint as the accepted persistence branch. Once a
recovery persistence operation fails, later mutations in that process are
refused. Evidence-ahead failures remain blocked by the existing checkpoint on
restart. The lock is released on every handled exit; the 60-second state-age
check, symmetric runtime lock enforcement, checkpoint/evidence revalidation,
and explicit operator assertion prevent concurrent operation with the web
runtime. The runbook forbids configuring the confirmation string on the web
service.

## Tests

Tests cover runtime-lock detection, confirmed and reverted receipts, recent
missing receipts, stale manual-review escalation, reservations without signed
bytes, provider errors,
invalid receipt status, missing/mismatched receipt identity, receipt-block
retention, final-record nonce residue, and a full real evidence-journal plus
atomic-state round trip through the isolated command. Injected state and
evidence writers both block recovery before its append. Provider error text is
not returned.

## Deliberate remaining blockers

1. Define journaled operator resolution for `manual-review`: confirmed rejection
   and nonce release for never-signed reservations; identical-payload rebroadcast
   or independently proven nonce consumption for dropped signed transactions.
2. Run and independently review the real-organization Turnkey behavioral matrix
   and pin the structured policy-denial field/code.
3. Implement journaled exact-approval orchestration, including zero-first and
   residue cleanup.
4. Implement the concrete per-intent preflight reads for policy state,
   WETH/native balances, daily spend, and post-buy sell simulation.
5. Implement the reviewed epoch-migration tool.
6. Bind qualified strategy decisions to immutable intents and complete a
   qualifying V6b cohort.

## Reviewer questions

1. Can recovery sign, broadcast, replace, or cancel any transaction?
2. Can a receipt from the wrong chain, hash, sender, or with an unknown status become a
   final execution record?
3. Can a nonce lane be released before the final receipt transition and its
   complete checkpoint are durable?
4. Do missing receipts, unsigned reservations, and provider errors remain
   activation blockers without excluding losses?
5. Can either process append evidence while the recovery lock exists, can the
   command miss an evidence-only concurrent write, or can it continue after a
   persistence failure?
6. Does runtime execution remain impossible?

## Expected verdict

- Merge as inert recovery scaffolding: reviewer decision.
- Deploy to production: not needed; no paper-runtime benefit.
- Enable micro-mainnet: **NO-GO**.
