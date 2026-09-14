import test from "node:test";
import assert from "node:assert/strict";
import { fetchLogsAdaptive } from "./rpc-log-query.js";

test("splits an oversized block range without skipping blocks", async () => {
  const ranges = [];
  const request = async (_method, [filter]) => {
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    ranges.push([from, to]);
    if (to - from >= 2) throw new Error("RPC endpoints unavailable: RPC HTTP 400 (eth_getLogs)");
    return [{ blockNumber: filter.fromBlock }];
  };
  const logs = await fetchLogsAdaptive({
    request, from: 10, to: 13, address: "0x1", topics: ["0xtopic"],
  });
  assert.deepEqual(ranges, [[10, 13], [10, 11], [12, 13]]);
  assert.deepEqual(logs.map((log) => log.blockNumber), ["0xa", "0xc"]);
});

test("splits address batches when one block still exceeds the provider limit", async () => {
  const sizes = [];
  const request = async (_method, [filter]) => {
    const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
    sizes.push(addresses.length);
    if (addresses.length > 2) throw new Error("RPC endpoints unavailable: RPC HTTP 400 (eth_getLogs)");
    return addresses.map((entry) => ({ address: entry }));
  };
  const address = ["0x1", "0x2", "0x3", "0x4"];
  const logs = await fetchLogsAdaptive({ request, from: 20, to: 20, address, topics: [] });
  assert.deepEqual(sizes, [4, 2, 2]);
  assert.deepEqual(logs.map((log) => log.address), address);
});

test("normalizes a singleton address batch to a scalar filter", async () => {
  let observedAddress;
  const request = async (_method, [filter]) => {
    observedAddress = filter.address;
    return [];
  };
  await fetchLogsAdaptive({ request, from: 1, to: 1, address: ["0x1"], topics: [] });
  assert.equal(observedAddress, "0x1");
});

test("fails closed when a single-block single-address query is rejected", async () => {
  const request = async () => {
    throw new Error("RPC endpoints unavailable: RPC HTTP 400 (eth_getLogs)");
  };
  await assert.rejects(
    fetchLogsAdaptive({ request, from: 30, to: 30, address: "0x1", topics: [] }),
    /RPC HTTP 400/,
  );
});

test("does not split unrelated RPC failures", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error("RPC endpoints unavailable: RPC HTTP 429 (eth_getLogs)");
  };
  await assert.rejects(
    fetchLogsAdaptive({ request, from: 1, to: 100, address: ["0x1", "0x2"], topics: [] }),
    /RPC HTTP 429/,
  );
  assert.equal(calls, 1);
});
