import http from "node:http";
import { rankPools } from "./signals.js";
import { decodeSwapEvent } from "./market-data.js";
import { evaluateRiskGate } from "./risk-gate.js";
import { loadExecutionConfig } from "./wallet.js";
import { PaperPortfolio } from "./paper-portfolio.js";
import { DEFAULT_PAPER_STRATEGY, planPaperEntry, paperExitReason } from "./paper-strategy.js";
import { ROBINHOOD } from "./chain-config.js";
import { decodeV2Reserves, evaluateV2MarketSafety, evaluateV3MarketSafety } from "./market-safety.js";
import { decodeUint, decodeV3Slot0 } from "./v3-simulator.js";
import { bitmapPosition, compressTick, encodeInt16Call, findInitializedTickInWord } from "./tick-boundary.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { assessReadiness } from "./readiness.js";
import { nextBackoffMs, RpcScheduler } from "./rpc-scheduler.js";

const PORT = Number(process.env.PORT || 3000);
const RPC_URL = process.env.RPC_URL || ROBINHOOD.rpcUrl;
const CHAIN_ID = ROBINHOOD.chainId;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const RPC_MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS || 250);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 100);
const BACKFILL = 20_000;
const CHUNK = 500;
const MAX_POOLS = 5_000;
const MAX_RECENT = 50;
const SIGNAL_WINDOW_BLOCKS = Number(process.env.SIGNAL_WINDOW_BLOCKS || 20);
const SIGNAL_MIN_SWAPS = Number(process.env.SIGNAL_MIN_SWAPS || 3);
const PAPER_INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000);
const PAPER_MAX_POSITIONS = Number(process.env.PAPER_MAX_POSITIONS || 3);
const PAPER_WETH_INITIAL_CASH = Number(process.env.PAPER_WETH_INITIAL_CASH || 0.1);
const PAPER_WETH_MAX_ENTRY = Number(process.env.PAPER_WETH_MAX_ENTRY || 0.01);
const PAPER_WETH_PROBE_WEI = BigInt(process.env.PAPER_WETH_PROBE_WEI || "1000000000000000");
const PAPER_USDG_PROBE_UNITS = BigInt(process.env.PAPER_USDG_PROBE_UNITS || "10");
const PAPER_CYCLE_MS = Number(process.env.PAPER_CYCLE_MS || 30_000);
const STATE_FILE = String(process.env.STATE_FILE || "");
const STATE_SAVE_MS = Number(process.env.STATE_SAVE_MS || 30_000);
const V3_BOUNDARY_CACHE_MS = Number(process.env.V3_BOUNDARY_CACHE_MS || 30_000);
const CANDIDATE_CACHE_MS = Number(process.env.CANDIDATE_CACHE_MS || 15_000);

const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const UNISWAP_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const pools = new Map();
const tokenCache = new Map();
const v3BoundaryCache = new Map();
const paperPortfolio = new PaperPortfolio({ initialCash: PAPER_INITIAL_CASH, maxPositions: PAPER_MAX_POSITIONS });
const wethPaperPortfolio = new PaperPortfolio({
  initialCash: PAPER_WETH_INITIAL_CASH, maxPositions: PAPER_MAX_POSITIONS,
});
const paperBooks = new Map([
  [ROBINHOOD.usdg.toLowerCase(), { symbol: "USDG", portfolio: paperPortfolio }],
  [ROBINHOOD.weth.toLowerCase(), { symbol: "WETH", portfolio: wethPaperPortfolio }],
]);
const rpcScheduler = new RpcScheduler({ minIntervalMs: RPC_MIN_INTERVAL_MS, jitterMs: RPC_JITTER_MS });
let pollRunning = false;
let nextPollDelayMs = POLL_MS;
let lastPaperCycleAt = 0;
let candidateCache = null;
let candidatePromise = null;
const paperAutomation = { cycles: 0, entries: 0, exits: 0, lastError: null, recentDecisions: [] };
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
const persistence = {
  enabled: Boolean(STATE_FILE), restored: false, restoredCursor: null, restoredPoolCount: 0,
  lastSavedAt: null, lastAttemptAt: 0, lastError: null, stateFile: STATE_FILE ? "configured" : null,
};

function persistedState() {
  return {
    cursor: metrics.cursor,
    pools: [...pools.values()],
    paper: paperPortfolio.serialize(),
    paperBooks: Object.fromEntries([...paperBooks].map(([quoteToken, book]) => [
      quoteToken, { symbol: book.symbol, state: book.portfolio.serialize() },
    ])),
    paperAutomation,
  };
}

async function restoreState() {
  if (!STATE_FILE) return;
  try {
    const state = await loadJsonState(STATE_FILE);
    if (!state) return;
    for (const pool of (state.pools || []).slice(0, MAX_POOLS)) pools.set(pool.address, pool);
    metrics.cursor = Number(state.cursor) || 0;
    metrics.v2Pools = [...pools.values()].filter((pool) => pool.version === "v2").length;
    metrics.v3Pools = [...pools.values()].filter((pool) => pool.version === "v3").length;
    metrics.swaps = [...pools.values()].reduce((sum, pool) => sum + (Number(pool.swapCount) || 0), 0);
    if (state.paperBooks) {
      for (const [quoteToken, saved] of Object.entries(state.paperBooks)) {
        const book = paperBooks.get(quoteToken.toLowerCase());
        if (book && saved?.state) book.portfolio.restore(saved.state);
      }
    } else if (state.paper) paperPortfolio.restore(state.paper);
    if (state.paperAutomation) Object.assign(paperAutomation, state.paperAutomation);
    persistence.restored = true;
    persistence.restoredCursor = metrics.cursor;
    persistence.restoredPoolCount = pools.size;
    persistence.lastSavedAt = state.savedAt;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.message : String(error);
  }
}

async function persistState(force = false) {
  if (!STATE_FILE) return;
  const now = Date.now();
  if (!force && now - persistence.lastAttemptAt < STATE_SAVE_MS) return;
  persistence.lastAttemptAt = now;
  try {
    await saveJsonState(STATE_FILE, persistedState());
    persistence.lastSavedAt = Date.now();
    persistence.lastError = null;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.message : String(error);
  }
}

async function rpc(method, params) {
  return rpcScheduler.schedule(async () => {
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
  });
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
  try {
    await scanRange(from, latest);
  } finally {
    metrics.backfill.active = false;
    metrics.backfill.current = Math.min(metrics.cursor || from, latest);
  }
}

async function poll() {
  if (pollRunning) {
    setTimeout(poll, POLL_MS);
    return;
  }
  pollRunning = true;
  try {
    const latest = intHex(await rpc("eth_blockNumber", []));
    if (!metrics.cursor) await bootstrap(latest);
    else if (latest > metrics.cursor) await scanRange(metrics.cursor + 1, latest);
    const block = await rpc("eth_getBlockByNumber", [hexBlock(latest), false]);
    metrics.latestBlock = latest;
    metrics.blockTimestamp = intHex(block?.timestamp);
    metrics.successfulPolls += 1;
    metrics.lastError = null;
    nextPollDelayMs = POLL_MS;
    const ready = assessReadiness({
      latestBlock: metrics.latestBlock, cursor: metrics.cursor,
      backfillActive: metrics.backfill.active, lastError: metrics.lastError,
    });
    if (ready.readyForPaper && Date.now() - lastPaperCycleAt >= PAPER_CYCLE_MS) {
      await runPaperCycle();
    }
    await persistState();
  } catch (error) {
    metrics.failedPolls += 1;
    metrics.lastError = error instanceof Error ? error.message : String(error);
    const rateLimited = metrics.lastError.includes("429");
    nextPollDelayMs = nextBackoffMs({
      currentMs: nextPollDelayMs, rateLimited, baseMs: POLL_MS,
    });
  } finally {
    await persistState();
    pollRunning = false;
    setTimeout(poll, nextPollDelayMs);
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
  const backfill = {
    ...metrics.backfill,
    active: metrics.backfill.active && metrics.cursor <= metrics.backfill.to,
    current: Math.min(metrics.backfill.current, metrics.backfill.to),
  };
  const readiness = assessReadiness({
    latestBlock: metrics.latestBlock, cursor: metrics.cursor,
    backfillActive: backfill.active, lastError: metrics.lastError,
  });
  return {
    mode: "OBSERVATION_ONLY_NO_PAPER_STRATEGY",
    chainId: CHAIN_ID, uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    latestBlock: metrics.latestBlock, blockTimestamp: metrics.blockTimestamp,
    cursor: metrics.cursor, polling: {
      configuredIntervalMs: POLL_MS, nextDelayMs: nextPollDelayMs, successful: metrics.successfulPolls,
      failed: metrics.failedPolls, lastError: metrics.lastError,
    },
    backfill,
    poolDiscovery: { v2Pools: metrics.v2Pools, v3Pools: metrics.v3Pools,
      totalPools: pools.size, swapsObserved: metrics.swaps, capacity: MAX_POOLS },
    venues: Object.fromEntries(["pancakeswap", "uniswap"].map((dex) => [dex,
      [...pools.values()].filter((pool) => pool.dex === dex).length])),
    rpcLatencyMs: metrics.rpcLatencyMs,
    rpcScheduler: rpcScheduler.snapshot(),
    v3BoundarySearch: {
      cachedWords: v3BoundaryCache.size,
      unresolved: 0,
      method: "current-word-conservative-edge",
    },
    readiness,
    persistence,
  };
}

function signals(limit = 25) {
  return rankPools([...pools.values()], metrics.latestBlock || metrics.cursor, {
    windowBlocks: SIGNAL_WINDOW_BLOCKS,
    minSwaps: SIGNAL_MIN_SWAPS,
  }).slice(0, limit);
}

async function resolveV3Boundary(pool, currentTick, tickSpacing, zeroForOne) {
  const compressedTick = compressTick(currentTick, tickSpacing);
  const { wordPos } = bitmapPosition(compressedTick);
  const key = `${pool.address}:${zeroForOne ? "down" : "up"}:${wordPos}`;
  const cached = v3BoundaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.boundaryTick;

  const currentBitmap = decodeUint(await rpc("eth_call", [{
    to: pool.address, data: encodeInt16Call("0x5339c296", wordPos),
  }, "latest"]), "tick-bitmap");
  const initializedTick = findInitializedTickInWord({
    bitmap: currentBitmap, wordPos, currentCompressedTick: compressedTick,
    tickSpacing, zeroForOne,
  });
  const conservativeWordEdge = (
    zeroForOne ? wordPos * 256 : (wordPos + 1) * 256
  ) * tickSpacing;
  const boundaryTick = initializedTick ?? conservativeWordEdge;
  v3BoundaryCache.set(key, {
    boundaryTick, expiresAt: Date.now() + V3_BOUNDARY_CACHE_MS,
  });
  return boundaryTick;
}

async function marketSafety(pool) {
  const quoteTokens = [ROBINHOOD.weth, ROBINHOOD.usdg];
  const quoteAddresses = quoteTokens.map((address) => address.toLowerCase());
  const quoteIsToken0 = quoteAddresses.includes(pool.token0);
  const quoteIsToken1 = quoteAddresses.includes(pool.token1);
  const base = {
    quoteTokenKnown: quoteIsToken0 !== quoteIsToken1,
    quoteToken: quoteIsToken0 ? pool.token0 : quoteIsToken1 ? pool.token1 : null,
    baseToken: quoteIsToken0 ? pool.token1 : quoteIsToken1 ? pool.token0 : null,
    liquidityKnown: false, buySimulationOk: false, sellSimulationOk: false,
    poolAgeBlocks: (metrics.latestBlock || metrics.cursor) - pool.discoveryBlock,
    priceImpactPct: null, roundTripLossPct: null,
  };
  if (!base.quoteTokenKnown) return base;
  try {
    const [token0Meta, token1Meta] = await Promise.all([
      tokenMeta(pool.token0), tokenMeta(pool.token1),
    ]);
    const quoteAddress = quoteIsToken0 ? pool.token0 : pool.token1;
    const quoteDecimals = quoteIsToken0 ? token0Meta.decimals : token1Meta.decimals;
    const quoteAmountIn = quoteAddress === ROBINHOOD.usdg.toLowerCase()
      ? PAPER_USDG_PROBE_UNITS * (10n ** BigInt(quoteDecimals))
      : PAPER_WETH_PROBE_WEI;
    if (pool.version === "v2") {
      const reserves = decodeV2Reserves(await rpc("eth_call",
        [{ to: pool.address, data: "0x0902f1ac" }, "latest"]));
      return evaluateV2MarketSafety(pool, {
        latestBlock: metrics.latestBlock || metrics.cursor,
        quoteTokens, reserve0: reserves.reserve0, reserve1: reserves.reserve1,
        token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
        quoteAmountIn,
      });
    }
    const [slot0Result, liquidityResult, tickSpacingResult] = await Promise.all([
      rpc("eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0xd0c93a7c" }, "latest"]),
    ]);
    const slot0 = decodeV3Slot0(slot0Result);
    const tickSpacing = Number(decodeUint(tickSpacingResult, "tick-spacing"));
    const boundaryTick = await resolveV3Boundary(
      pool, slot0.tick, tickSpacing, quoteIsToken0,
    );
    return evaluateV3MarketSafety(pool, {
      latestBlock: metrics.latestBlock || metrics.cursor,
      quoteTokens, sqrtPriceX96: slot0.sqrtPriceX96, currentTick: slot0.tick,
      liquidity: decodeUint(liquidityResult, "liquidity"), boundaryTick,
      token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
      quoteAmountIn,
    });
  } catch (error) {
    return { ...base, measurementError: error instanceof Error ? error.message : String(error) };
  }
}

async function measureCandidates(limit) {
  const ranked = signals(limit);
  return Promise.all(ranked.map(async (pool) => {
    const measured = { ...pool, marketSafety: await marketSafety(pool) };
    return { ...measured, riskGate: evaluateRiskGate(measured) };
  }));
}

async function candidates(limit = 10) {
  const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
  if (candidateCache && candidateCache.expiresAt > Date.now()
      && candidateCache.limit >= boundedLimit) {
    return candidateCache.value.slice(0, boundedLimit);
  }
  if (!candidatePromise) {
    candidatePromise = measureCandidates(Math.max(10, boundedLimit))
      .then((value) => {
        candidateCache = {
          value, limit: Math.max(10, boundedLimit),
          expiresAt: Date.now() + CANDIDATE_CACHE_MS,
        };
        return value;
      })
      .finally(() => { candidatePromise = null; });
  }
  return (await candidatePromise).slice(0, boundedLimit);
}

function rememberPaperDecision(decision) {
  paperAutomation.recentDecisions.push({ at: Date.now(), ...decision });
  if (paperAutomation.recentDecisions.length > 50) paperAutomation.recentDecisions.shift();
}

async function runPaperCycle() {
  lastPaperCycleAt = Date.now();
  paperAutomation.cycles += 1;
  try {
    for (const [quoteToken, book] of paperBooks) {
      for (const position of book.portfolio.snapshot().openPositions) {
        const pool = pools.get(position.pool);
        if (!pool) continue;
        const safety = await marketSafety(pool);
        if (safety.quoteToken !== quoteToken || !Number.isFinite(safety.tokenPriceQuote)) continue;
        const marked = book.portfolio.mark(position.pool, safety.tokenPriceQuote);
        const reason = paperExitReason(marked);
        if (reason) {
          const fee = marked.marketValue * 0.003;
          book.portfolio.close({ pool: position.pool, price: safety.tokenPriceQuote, fee, reason });
          paperAutomation.exits += 1;
          rememberPaperDecision({
            type: "exit", quote: book.symbol, pool: position.pool,
            reason, price: safety.tokenPriceQuote,
          });
        }
      }
    }

    const measured = await candidates(10);
    for (const candidate of measured) {
      const book = paperBooks.get(candidate.marketSafety.quoteToken);
      if (!book) {
        rememberPaperDecision({ type: "reject", pool: candidate.address,
          reasons: ["unsupported-paper-quote"] });
        continue;
      }
      const policy = book.symbol === "WETH"
        ? { ...DEFAULT_PAPER_STRATEGY, maxEntryNotional: PAPER_WETH_MAX_ENTRY }
        : DEFAULT_PAPER_STRATEGY;
      const plan = planPaperEntry(candidate, book.portfolio.snapshot(), policy);
      if (!plan.approved) {
        rememberPaperDecision({ type: "reject", quote: book.symbol,
          pool: candidate.address, reasons: plan.failures });
        continue;
      }
      const feeRate = candidate.version === "v3"
        ? Number(candidate.fee || 3000) / 1_000_000
        : candidate.dex === "pancakeswap" ? 0.0025 : 0.003;
      const fee = plan.order.notional * feeRate;
      book.portfolio.open({ ...plan.order, fee });
      paperAutomation.entries += 1;
      rememberPaperDecision({ type: "entry", quote: book.symbol, pool: candidate.address,
        price: plan.order.price, notional: plan.order.notional, fee });
    }
    paperAutomation.lastError = null;
  } catch (error) {
    paperAutomation.lastError = error instanceof Error ? error.message : String(error);
  }
}

function paperStatus() {
  return {
    mode: "PAPER_ONLY",
    books: Object.fromEntries([...paperBooks.values()].map((book) => [
      book.symbol, { quote: book.symbol, ...book.portfolio.snapshot() },
    ])),
    automation: { ...paperAutomation, cycleIntervalMs: PAPER_CYCLE_MS,
      lastCycleAt: lastPaperCycleAt || null },
  };
}

async function dashboard() {
  const active = signals(10);
  const cards = [];
  for (const pool of active) {
    const [a, b] = await Promise.all([tokenMeta(pool.token0), tokenMeta(pool.token1)]);
    cards.push(`<article><b>${esc(a.symbol)}/${esc(b.symbol)}</b><span>${esc(pool.dex || "unknown")} · ${pool.version.toUpperCase()}${pool.fee ? ` · ${pool.fee / 10000}%` : ""} · ${esc(pool.signal.state)}</span><small>${esc(pool.address)} · score ${pool.signal.score} · ${pool.signal.swapsCurrentWindow} recent swaps · ${pool.signal.acceleration}× acceleration</small></article>`);
  }
  const s = snapshot();
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Robinhood Observer</title><style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:auto;max-width:720px;padding:18px}h1{font-size:23px}.warn{background:#713f12;padding:12px;border-radius:10px}.grid,article{display:grid;gap:9px}section,article{background:#1f2937;margin:12px 0;padding:15px;border-radius:12px}article span,small{color:#9ca3af}code{color:#86efac}</style><h1>Robinhood Chain Observer</h1><p class="warn">OBSERVATION ONLY / NO PAPER STRATEGY YET<br>In-memory state resets on redeploy.</p><section class="grid"><b>Chain <code>4663</code></b><span>Latest block: ${s.latestBlock.toLocaleString()}</span><span>Cursor: ${s.cursor.toLocaleString()}</span><span>Pools: ${pools.size} (${metrics.v2Pools} V2 / ${metrics.v3Pools} V3)</span><span>Swaps observed: ${metrics.swaps}</span><span>Polls: ${metrics.successfulPolls} successful / ${metrics.failedPolls} failed</span><span>Last error: ${esc(metrics.lastError || "none")}</span><span>Paper readiness: ${s.readiness.readyForPaper ? "ready" : esc(s.readiness.reasons.join(", "))}</span></section><h2>Most active pools</h2>${cards.join("") || "<section>Waiting for pool events in the observation window.</section>"}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") { res.writeHead(405).end("Method Not Allowed"); return; }
    if (req.url === "/health") return json(res, { status: "ok", ...snapshot() });
    if (req.url === "/api/scanner") return json(res, snapshot());
    if (req.url === "/api/pools") return json(res, { total: pools.size, pools: [...pools.values()].slice(0, 100) });
    if (req.url === "/api/signals") return json(res, { mode: "PAPER_SIGNAL_ONLY", signals: signals() });
    if (req.url === "/api/candidates") return json(res, { mode: "PAPER_FAIL_CLOSED", candidates: await candidates() });
    if (req.url === "/api/wallet") return json(res, executionConfig.publicStatus);
    if (req.url === "/api/paper") return json(res, paperStatus());
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await dashboard()); return; }
    res.writeHead(404).end("Not Found");
  } catch (error) { res.writeHead(500).end("Internal Error"); }
});

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

await restoreState();
server.listen(PORT, "0.0.0.0", () => console.log(`Read-only observer listening on ${PORT}`));
poll();

async function shutdown() {
  await persistState(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
