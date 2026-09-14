import test from "node:test";
import assert from "node:assert/strict";
import { RpcTransport, rpcUrlsFromEnv } from "./rpc-transport.js";

const response = (status, body = { result: "0x1237" }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("builds a deduplicated primary and fallback endpoint list", () => {
  assert.deepEqual(rpcUrlsFromEnv({
    primary: "https://one", fallbacks: "https://two, https://one\nhttps://three",
    defaultUrl: "https://default",
  }), ["https://one", "https://two", "https://three"]);
});

test("fails over on provider HTTP failure without exposing endpoint URLs", async () => {
  const calls = [];
  const transport = new RpcTransport({
    urls: ["https://primary/key", "https://backup/key"], cooldownMs: 60_000,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("primary") ? response(403) : response(200);
    },
  });
  assert.equal(await transport.request("eth_chainId", []), "0x1237");
  assert.deepEqual(calls, ["https://primary/key", "https://backup/key"]);
  assert.deepEqual(transport.snapshot(), {
    endpointCount: 2, activeEndpoint: 2, requestCount: 1,
    failureCount: 1, failoverCount: 1, coolingDown: 1,
  });
});

test("sticks to the healthy fallback while the failed endpoint cools down", async () => {
  const calls = [];
  const transport = new RpcTransport({
    urls: ["https://primary", "https://backup"],
    fetchImpl: async (url) => {
      calls.push(url);
      return url.includes("primary") ? response(503) : response(200, { result: "ok" });
    },
  });
  await transport.request("first", []);
  await transport.request("second", []);
  assert.deepEqual(calls, ["https://primary", "https://backup", "https://backup"]);
});

test("does not retry a JSON-RPC application error on another provider", async () => {
  let calls = 0;
  const transport = new RpcTransport({
    urls: ["https://one", "https://two"],
    fetchImpl: async () => {
      calls += 1;
      return response(200, { error: { message: "invalid params" } });
    },
  });
  await assert.rejects(transport.request("bad", []), /invalid params/);
  assert.equal(calls, 1);
});
