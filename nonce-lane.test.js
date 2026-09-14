import test from "node:test";
import assert from "node:assert/strict";
import { NonceLane } from "./nonce-lane.js";

const walletAddress = "0x1111111111111111111111111111111111111111";
const request = { chainId: 4663, walletAddress, intentId: "entry:1" };

test("reserves the provider pending nonce and persists it", async () => {
  const states = [];
  const lane = new NonceLane({}, { persist: async (state) => states.push(state) });
  assert.equal(await lane.reserve(request, async () => 7), 7);
  assert.equal(states[0].lanes[0].pending.nonce, 7);
  assert.equal(states[0].lanes[0].nextNonce, 8);
});

test("blocks a second intent until the first nonce is finalized", async () => {
  const lane = new NonceLane();
  await lane.reserve(request, async () => 2);
  await assert.rejects(
    lane.reserve({ ...request, intentId: "entry:2" }, async () => 2), /nonce-lane-blocked/,
  );
  await lane.finalize("entry:1");
  assert.equal(await lane.reserve({ ...request, intentId: "entry:2" }, async () => 2), 3);
});

test("serializes concurrent reservations for one wallet and chain", async () => {
  const lane = new NonceLane();
  const [first, second] = await Promise.allSettled([
    lane.reserve(request, async () => 4),
    lane.reserve({ ...request, intentId: "entry:2" }, async () => 4),
  ]);
  assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
  assert.match([first, second].find((result) => result.status === "rejected").reason.message, /blocked/);
});

test("restored pending nonce keeps the lane blocked", async () => {
  const original = new NonceLane();
  await original.reserve(request, async () => 9);
  const restored = new NonceLane(original.snapshot());
  await assert.rejects(
    restored.reserve({ ...request, intentId: "entry:2" }, async () => 10), /nonce-lane-blocked/,
  );
});

test("persistence failure rolls the reservation back", async () => {
  const lane = new NonceLane({}, { persist: async () => { throw new Error("disk-full"); } });
  await assert.rejects(lane.reserve(request, async () => 1), /disk-full/);
  assert.deepEqual(lane.snapshot(), { lanes: [] });
});
