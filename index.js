import http from "node:http";
import { rankPools } from "./signals.js";
import { decodeSwapEvent } from "./market-data.js";
import { evaluateRiskGate } from "./risk-gate.js";
import { loadExecutionConfig } from "./wallet.js";
import { PaperPortfolio } from "./paper-portfolio.js";
import { ROBINHOOD } from "./chain-config.js";

const PORT = Number(process.env.PORT || 3000);
const RPC_URL = process.env.RPC_URL || ROBINHOOD.rpcUrl;
const CHAIN_ID = ROBINHOOD.chainId;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const BACKFILL = 20_000;
const CHUNK = 500;
const MAX_POOLS = 5_000;
const MAX_RECENT = 50;
const SIGNAL_WINDOW_BLOCKS = Number(process.env.SIGNAL_WINDOW_BLOCKS || 20);
const SIGNAL_MIN_SWAPS = Number(process.env.SIGNAL_MIN_SWAPS || 3);
const PAPER_INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000);
const PAPER_MAX_POSITIONS = Number(process.env.PAPER_MAX_POSITIONS || 3);

const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const UNISWAP_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const pools = new Map();
const tokenCache = new Map();
const paperPortfolio = new PaperPortfolio({ initialCash: PAPER_INITIAL_CASH, maxPositions: PAPER_MAX_POSITIONS });
let executionConfig;
try { executionConfig = loadExecutionConfig(); }
catch (error) {
  console.error(`Wallet configuration rejected: ${error instanceof Error ? error.message : String(error)}`);
  executionConfig = { armed: false, account: null,
    publicStatus: { armed: false, walletConfigured: false, address: null } };
}
const metrics = {
  startedAt: Date.now(), latestBlock: 0, blockTimestamp: 0, cursor: 0,
  successfulPolls: 0, failedPolls: 0, lastError: null,
  backfill: { active: false, from: 0, to: 0, current: 0 },
  v2Pools: 0, v3Pools: 0, swaps: 0, rpcLatencyMs: 0,
};

async function rpc(method, params) {
  const started = Date.now();
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  metrics.rpcLatencyMs = Date.now() - started;
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC: ${body.error.message}`);
  return body.result;
}

const hexBlock = (n) => `0x${n.toString(16)}`;
const intHex = (value) => Number.parseInt(value || "0x0", 16);
const topicAddress = (topic) => `0x${String(topic).slice(-40)}`.toLowerCase();
const dataWord = (data, index) => String(data).slice(2 + index * 64, 66 + index * 64);
const wordAddress = (data, index) => `0x${dataWord(data, index).slice(-40)}`.toLowerCase();

async function getLogs(from, to, address, topics) {
  const result = await rpc("eth_getLogs", [{
    fromBlock: hexBlock(from), toBlock: hexBlock(to), address, topics,
  }]);
  return (result || []).map((log) => ({ ...log, blockNumber: intHex(log.blockNumber) }));
}

function registerPool(pool) {
  if (pools.has(pool.address) || pools.size >= MAX_POOLS) return;
  pools.set(pool.address, { ...pool, swapCount: 0, lastSwapBlock: 0, recent: [] });
  if (pool.version === "v2") metrics.v2Pools += 1;
  else metrics.v3Pools += 1;
}

async function discover(from, to) {
  const batches = await Promise.all(ROBINHOOD.factories.map(async (factory) => ({
    factory, logs: await getLogs(from, to, factory.address,
      [factory.version === "v2" ? PAIR_CREATED : POOL_CREATED]),
  })));
  for (const { factory, logs } of batches) {
    for (const log of logs) {
      const poolWord = factory.version === "v2" ? 0 : 1;
      if (log.topics.length < (factory.version === "v2" ? 3 : 4) || dataWord(log.data, poolWord).length !== 64) continue;
      registerPool({
        address: wordAddress(log.data, poolWord), dex: factory.dex, version: factory.version,
        token0: topicAddress(log.topics[1]), token1: topicAddress(log.topics[2]),
        fee: factory.version === "v3" ? intHex(log.topics[3]) : null,
        discoveryBlock: log.blockNumber,
      });
    }
  }
}

function recordSwap(log) {
  const pool = pools.get(String(log.address).toLowerCase());
  if (!pool) return;
  pool.swapCount += 1;
  pool.lastSwapBlock = log.blockNumber;
  pool.recent.push(log.blockNumber);
  if (pool.recent.length > MAX_RECENT) pool.recent.shift();
  try {
    pool.lastSwap = {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      ...decodeSwapEvent(log, pool.version),
    };
    pool.decodeError = null;
  } catch (error) {
    pool.decodeError = error instanceof Error ? error.message : String(error);
  }
  metrics.swaps += 1;
}

async function observeSwaps(from, to) {
  const groups = [
    { version: "v2", topics: [V2_SWAP] },
    { version: "v3", topics: [[PANCAKE_V3_SWAP, UNISWAP_V3_SWAP]] },
  ];
  for (const group of groups) {
    const addresses = [...pools.values()]
      .filter((pool) => pool.version === group.version)
      .map((pool) => pool.address);
    for (let i = 0; i < addresses.length; i += 100) {
      const logs = await getLogs(from, to, addresses.slice(i, i + 100), group.topics);
      logs.forEach(recordSwap);
    }
  }
}

async function scanRange(from, to) {
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, to);
    await discover(start, end);
    await observeSwaps(start, end);
    metrics.cursor = end;
    if (metrics.backfill.active) metrics.backfill.current = end;
  }
}

async function bootstrap(latest) {
  const from = Math.max(1, latest - BACKFILL);
  metrics.backfill = { active: true, from, to: latest, current: from };
  await scanRange(from, latest);
  metrics.backfill.active = false;
}

async function poll() {
  try {
    const latest = intHex(await rpc("eth_blockNumber", []));
    if (!metrics.cursor) await bootstrap(latest);
    else if (latest > metrics.cursor) await scanRange(metrics.cursor + 1, latest);
    const block = await rpc("eth_getBlockByNumber", [hexBlock(latest), false]);
    metrics.latestBlock = latest;
    metrics.blockTimestamp = intHex(block?.timestamp);
    metrics.successfulPolls += 1;
    metrics.lastError = null;
  } catch (error) {
    metrics.failedPolls += 1;
    metrics.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

function decodeSymbol(result) {
  if (!result || result === "0x") return "UNK";
  const hex = result.slice(2);
  try {
    if (hex.length === 64) return Buffer.from(hex.replace(/00+$/, ""), "hex").toString("utf8") || "UNK";
    const offset = Number.parseInt(hex.slice(0, 64), 16) * 2;
    const length = Number.parseInt(hex.slice(offset, offset + 64), 16) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + length), "hex").toString("utf8") || "UNK";
  } catch { return "UNK"; }
}

async function tokenMeta(address) {
  if (tokenCache.has(address)) return tokenCache.get(address);
  let meta = { symbol: "UNK", decimals: 18 };
  try {
    const [symbol, decimals] = await Promise.all([
      rpc("eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]),
      rpc("eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
    ]);
    meta = { symbol: decodeSymbol(symbol).slice(0, 20), decimals: intHex(decimals) };
  } catch {}
  tokenCache.set(address, meta);
  return meta;
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
})[c]);

function snapshot() {
  return {
    mode: "OBSERVATION_ONLY_NO_PAPER_STRATEGY",
    chainId: CHAIN_ID, uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    latestBlock: metrics.latestBlock, blockTimestamp: metrics.blockTimestamp,
    cursor: metrics.cursor, polling: {
      intervalMs: POLL_MS, successful: metrics.successfulPolls,
      failed: metrics.failedPolls, lastError: metrics.lastError,
    },
    backfill: metrics.backfill,
    pancakeswap: { v2Pools: metrics.v2Pools, v3Pools: metrics.v3Pools,
      totalPools: pools.size, swapsObserved: metrics.swaps, capacity: MAX_POOLS },
    venues: Object.fromEntries(["pancakeswap", "uniswap"].map((dex) => [dex,
      [...pools.values()].filter((pool) => pool.dex === dex).length])),
    rpcLatencyMs: metrics.rpcLatencyMs,
  };
}

function signals(limit = 25) {
  return rankPools([...pools.values()], metrics.latestBlock || metrics.cursor, {
    windowBlocks: SIGNAL_WINDOW_BLOCKS,
    minSwaps: SIGNAL_MIN_SWAPS,
  }).slice(0, limit);
}

function candidates(limit = 25) {
  return signals(limit).map((pool) => ({ ...pool, riskGate: evaluateRiskGate(pool) }));
}

async function dashboard() {
  const active = signals(10);
  const cards = [];
  for (const pool of active) {
    const [a, b] = await Promise.all([tokenMeta(pool.token0), tokenMeta(pool.token1)]);
    cards.push(`<article><b>${esc(a.symbol)}/${esc(b.symbol)}</b><span>${esc(pool.dex || "unknown")} · ${pool.version.toUpperCase()}${pool.fee ? ` · ${pool.fee / 10000}%` : ""} · ${esc(pool.signal.state)}</span><small>${esc(pool.address)} · score ${pool.signal.score} · ${pool.signal.swapsCurrentWindow} recent swaps · ${pool.signal.acceleration}× acceleration</small></article>`);
  }
  const s = snapshot();
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Robinhood Observer</title><style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:auto;max-width:720px;padding:18px}h1{font-size:23px}.warn{background:#713f12;padding:12px;border-radius:10px}.grid,article{display:grid;gap:9px}section,article{background:#1f2937;margin:12px 0;padding:15px;border-radius:12px}article span,small{color:#9ca3af}code{color:#86efac}</style><h1>Robinhood Chain Observer</h1><p class="warn">OBSERVATION ONLY / NO PAPER STRATEGY YET<br>In-memory state resets on redeploy.</p><section class="grid"><b>Chain <code>4663</code></b><span>Latest block: ${s.latestBlock.toLocaleString()}</span><span>Cursor: ${s.cursor.toLocaleString()}</span><span>Pools: ${pools.size} (${metrics.v2Pools} V2 / ${metrics.v3Pools} V3)</span><span>Swaps observed: ${metrics.swaps}</span><span>Polls: ${metrics.successfulPolls} successful / ${metrics.failedPolls} failed</span><span>Last error: ${esc(metrics.lastError || "none")}</span></section><h2>Most active pools</h2>${cards.join("") || "<section>Waiting for pool events in the observation window.</section>"}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") { res.writeHead(405).end("Method Not Allowed"); return; }
    if (req.url === "/health") return json(res, { status: "ok", ...snapshot() });
    if (req.url === "/api/scanner") return json(res, snapshot());
    if (req.url === "/api/pools") return json(res, { total: pools.size, pools: [...pools.values()].slice(0, 100) });
    if (req.url === "/api/signals") return json(res, { mode: "PAPER_SIGNAL_ONLY", signals: signals() });
    if (req.url === "/api/candidates") return json(res, { mode: "PAPER_FAIL_CLOSED", candidates: candidates() });
    if (req.url === "/api/wallet") return json(res, executionConfig.publicStatus);
    if (req.url === "/api/paper") return json(res, paperPortfolio.snapshot());
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await dashboard()); return; }
    res.writeHead(404).end("Not Found");
  } catch (error) { res.writeHead(500).end("Internal Error"); }
});

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

server.listen(PORT, "0.0.0.0", () => console.log(`Read-only observer listening on ${PORT}`));
poll();
