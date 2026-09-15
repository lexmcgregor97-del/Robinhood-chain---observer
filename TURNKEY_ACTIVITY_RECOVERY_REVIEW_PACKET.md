# Atlas Turnkey Activity Listing and Restoration — Review Packet (revision 2)

## Scope

Review branch `fix/turnkey-activity-listing` against production `main` at
`afc34fafa6326364c7b5af6cbdcdba716a601c6c`. Production remains V6b
`PAPER_ONLY`. This connects the already-merged ambiguous-signing verifier to
the existing isolated recovery command; it does not connect the web runtime or
add broadcasting.

## Change

`findUniqueAmbiguousSigningActivity` calls Turnkey `getActivities` with server
filters for completed `SIGN_TRANSACTION_V2` activities and cursor pagination of
at most 100 entries per page. Pages must be newest-first, IDs must be unique,
timestamps must be valid and non-increasing, and pagination must terminate
within the configured page ceiling. Scanning continues until a short page or
until the ordered results cross below the record's signing-window lower bound.
The first result of a later page may repeat that page's `before` cursor and is
skipped exactly once, tolerating either inclusive or exclusive Turnkey cursor
semantics; every other repeated ID is refused. Returned activities must also
match both requested server-side filters, so short-page exhaustion does not
silently rely on the server honoring them.

Every listed activity is passed through the complete protocol-v3 verifier.
Candidate counting therefore occurs only after organization, status, type,
signing user, wallet, signing window, signer, chain, nonce, canonical intent
digest, unsigned/signed equality, EIP-1559 type, gas, and fee checks. Unrelated
same-nonce activities do not count. Zero or multiple verified candidates fail
closed.

`restoreUniqueAmbiguousSigningActivity` fetches the sole candidate again with
`getActivity(activityId)`, requires the returned ID to match, and passes those
fresh raw bytes to `ExecutionManualReviewResolver`, which independently
re-verifies before its journal mutation.

The existing `recover:executions` command exposes the path only with:

- its existing offline confirmation and exclusive state/evidence lock;
- a target that was already durably `manual-review` before reconciliation;
- exact `RESTORE_ATLAS_SIGNED_TRANSACTION_FROM_TURNKEY` assertion;
- complete observer credentials and read-only attestation;
- live verification that the observer user is outside root quorum, owns the
  API key, sees its attested deny policy, and has no applicable allow policy;
- a signing-user ID distinct from the observer user;
- the same gas and fee caps used by micro-mainnet configuration.
- an explicit positive `TURNKEY_ACTIVITY_MAX_PAGES` operator decision; there is
  no command default, and reaching the ceiling fails closed.

The successful command report and durable `operatorResolution` both include
the selected activity ID, unique scanned-activity count, and exact start/end of
the signing window.

## Safety boundary

- Only the observer private key is accepted; signing and attestation private
  keys remain forbidden by the recovery command.
- The lock remains held across RPC reconciliation, Turnkey listing, candidate
  re-fetch, verification, evidence append, and atomic state checkpoint.
- Concurrent state or evidence writes make persistence fail closed and roll
  back the in-memory transition.
- Successful restoration changes `manual-review` to `signed`; it neither
  finalizes the pending nonce nor broadcasts, replaces, or cancels anything.
- `index.js` does not import the listing/restoration module or recovery command.
- Micro-mainnet remains disabled.

## Validation

- `npm run check`: passing
- `npm test`: 279/279 passing on the dependency-complete runner
- `git diff --check`: clean

Tests cover digest-first selection in the presence of a genuine unrelated
same-nonce signature, zero/multiple refusal, multi-page traversal through the
window boundary, inclusive-cursor tolerance, malformed order, illegal
duplicates, server-filter violations, page ceiling, ID drift, fresh activity
use, observer-policy verification, durable discovery metadata, stale-label
clearing, and retention of the nonce lane.

## Deliberate remaining blockers

1. Implement isolated identical-payload rebroadcast with receipt recovery.
2. Define independently proven nonce-consumption handling for cases where the
   recovered payload cannot be rebroadcast.
3. Complete the other existing micro-mainnet gates.

## Reviewer questions

1. Does pagination prove the complete bounded signing window was searched?
2. Are candidates counted only after the full intent-digest match?
3. Can unrelated same-nonce activity block or replace the intended candidate?
4. Can zero, multiple, malformed, duplicated, or truncated results mutate state?
5. Is the chosen activity fetched and cryptographically re-verified immediately
   before the journal transition?
6. Can the observer credential sign, or can the command accept signing secrets?
7. Does every failed path retain the nonce and original manual-review record?
8. Is the web runtime still disconnected from listing, restoration, and broadcast?

## Required verdicts

- Merge isolated activity recovery: **GO / NO-GO**
- Deploy in `PAPER_ONLY`: **GO / NO-GO**
- Enable micro-mainnet: expected **NO-GO**

Report correctness findings by severity with exact file/line references and
the smallest required correction. Separate optional hardening.
