// Imported only by the subprocess smoke test. No external fetch is possible.
import http from "node:http";
import { ROBINHOOD } from "../chain-config.js";

globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  process.send?.({ type: "rpc", method: request.method });
  const results = {
    eth_blockNumber: "0x100",
    eth_getLogs: [],
    eth_getBlockByNumber: { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` },
  };
  if (request.method === "eth_getLogs" && process.env.TEST_DISCOVER_NEW_POOL === "true"
      && Array.isArray(request.params[0].address)) {
    const word = (address) => `0x${address.slice(2).padStart(64, "0")}`;
    results.eth_getLogs = [{ address: ROBINHOOD.factories[0].address,
      blockNumber: "0x100", topics: [request.params[0].topics[0][0],
        word(ROBINHOOD.weth), word("0x" + "b".repeat(40))],
      data: word("0x" + "a".repeat(40)) }];
  }
  if (!(request.method in results)) throw new Error(`unexpected-offline-rpc:${request.method}`);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] }),
    { status: 200, headers: { "content-type": "application/json" } });
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send?.({ type: "ready", port: this.address().port }));
  return listen.apply(this, args);
};
