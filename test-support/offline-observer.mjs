// Imported only by the subprocess smoke test. No external fetch is possible.
import http from "node:http";

globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  process.send?.({ type: "rpc", method: request.method });
  const results = {
    eth_blockNumber: "0x100",
    eth_getLogs: [],
    eth_getBlockByNumber: { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` },
  };
  if (!(request.method in results)) throw new Error(`unexpected-offline-rpc:${request.method}`);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] }),
    { status: 200, headers: { "content-type": "application/json" } });
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send?.({ type: "ready", port: this.address().port }));
  return listen.apply(this, args);
};
