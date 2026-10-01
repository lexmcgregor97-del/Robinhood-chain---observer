import test from "node:test";
import assert from "node:assert/strict";
import { PaperOpportunities, opportunityQualification } from "./paper-opportunities.js";
import { planPaperEntry, DEFAULT_PAPER_STRATEGY } from "./paper-strategy.js";
const candidate = { address: "pool", riskGate: { eligibleForPaperEntry: false,
  failures: ["gas-estimate-required", "sell-probe-required"] },
  marketSafety: { tokenPriceQuote: 1, gasCostQuotePerSide: 0.01,
    baseTokenDecimals: 18, buyAmountOut: "5000000000000000000", plannedNotionalQuote: 5 } };
const portfolio = { cash: 100, openPositions: [], trades: [] };
const qualify = (c = candidate, p = portfolio) => opportunityQualification(c, p,
  DEFAULT_PAPER_STRATEGY, 1000, planPaperEntry);
test("qualification ignores only missing evidence and still checks sizing and capacity", () => {
  assert.equal(qualify(), true);
  assert.equal(candidate.riskGate.eligibleForPaperEntry, false);
  assert.equal(qualify({ ...candidate, riskGate: { eligibleForPaperEntry: false,
    failures: ["signal-not-ready", "sell-probe-required"] } }), false);
  assert.equal(qualify(candidate, { ...portfolio, cash: 50 }), false);
  assert.equal(qualify(candidate, { ...portfolio, openPositions: [{ pool: "pool" }] }), false);
  assert.equal(qualify({ ...candidate, riskGate: undefined }), false);
});
test("repeated evaluations form one episode and joint blockers survive restoration", () => {
  const tracker = new PaperOpportunities();
  const row = { cohort: "opportunity", candidate, reasons: candidate.riskGate.failures,
    qualified: true, approved: false, now: 1000 };
  const first = tracker.record(row);
  const second = tracker.record({ ...row, now: 2000 });
  assert.equal(first.episodeId, second.episodeId);
  const restored = new PaperOpportunities(tracker.snapshot());
  const third = restored.record({ ...row, now: 3000 });
  assert.equal(third.episodeId, first.episodeId);
  assert.equal(restored.snapshot().byCohort.opportunity.evidenceBlocked, 3);
  assert.equal(restored.snapshot().episodes, 1);
});
test("lost qualification or an observation gap creates a new episode", () => {
  const t = new PaperOpportunities();
  const row = { cohort: "c", candidate, reasons: [], qualified: true, approved: true, now: 1000 };
  t.record(row);
  t.record({ ...row, now: 2000, qualified: false, approved: false, reasons: ["signal-not-ready"] });
  t.record({ ...row, now: 3000 });
  t.record({ ...row, now: 304000 });
  assert.equal(t.snapshot().episodes, 3);
});
test("outcome is labeled mid-price movement, not profit, and cohorts stay separate", () => {
  const t = new PaperOpportunities();
  const row = { cohort: "c", candidate, reasons: [], qualified: true, approved: true, now: 1000 };
  t.record(row);
  const event = t.record({ ...row, now: 2000, candidate: { ...candidate,
    marketSafety: { ...candidate.marketSafety, tokenPriceQuote: 1.2 } } });
  assert.ok(Math.abs(event.observedMidPriceReturnPct - 20) < 1e-10);
  t.record({ ...row, cohort: "other" });
  assert.equal(t.snapshot().byCohort.c.episodes, 1);
  assert.equal(t.snapshot().byCohort.other.episodes, 1);
});
