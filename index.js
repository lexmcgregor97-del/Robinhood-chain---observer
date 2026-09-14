import http from "node:http";
import { rankPools } from "./signals.js";
import { decodeSwapEvent } from "./market-data.js";
import { evaluateRiskGate } from "./risk-gate.js";
import { PaperPortfolio } from "./paper-portfolio.js";
import {
  DEFAULT_PAPER_STRATEGY, planPaperEntry, paperExitReason, paperCircuitFailures,
} from "./paper-strategy.js";
import { analyzePaperTrades } from "./paper-analytics.js";
import { ShadowEvaluator } from "./shadow-evaluator.js";
import { auditSwapPrice } from "./price-audit.js";
import { ROBINHOOD } from "./chain-config.js";
import { decodeV2Reserves, evaluateV2MarketSafety, evaluateV3MarketSafety } from "./market-safety.js";
import { decodeUint, decodeV3Slot0, quoteV3WithinTick } from "./v3-simulator.js";
import { quoteV2 } from "./v2-simulator.js";
import {
  bitmapPosition, compressTick, encodeInt16Call, findInitializedTickInWord,
  staysWithinTickBoundary,
} from "./tick-boundary.js";
import { loadJsonState, saveJsonState } from "./state-store.js";
import { assessReadiness } from "./readiness.js";
import { nextBackoffMs, RpcScheduler } from "./rpc-scheduler.js";
import { createTokenMetadataLoader } from "./token-metadata.js";
import { LogDeduplicator } from "./log-deduplicator.js";
import { PositionLiveness } from "./position-liveness.js";

const PORT = Number(process.env.PORT || 3000);
const RPC_URL = process.env.RPC_URL || ROBINHOOD.rpcUrl;
const CHAIN_ID = ROBINHOOD.chainId;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 10_000);
const RPC_MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS || 250);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 100);
const BACKFILL = 20_000;
const CHUNK = 500;
const MAX_POOLS = 5_000;
const SIGNAL_WINDOW_MS = Number(process.env.SIGNAL_WINDOW_MS || 60_000);
const SIGNAL_BASELINE_MS = Number(process.env.SIGNAL_BASELINE_MS || 300_000);
const SIGNAL_HISTORY_MS = Math.max(
  SIGNAL_WINDOW_MS + SIGNAL_BASELINE_MS,
  Number(process.env.SIGNAL_HISTORY_MS || 10 * 60_000),
);
const SIGNAL_MIN_SWAPS = Number(process.env.SIGNAL_MIN_SWAPS || 3);
const PAPER_INITIAL_CASH = Number(process.env.PAPER_INITIAL_CASH || 1000);
const PAPER_MAX_POSITIONS = Number(process.env.PAPER_MAX_POSITIONS || 3);
const PAPER_WETH_INITIAL_CASH = Number(process.env.PAPER_WETH_INITIAL_CASH || 0.1);
const PAPER_WETH_MAX_ENTRY = Number(process.env.PAPER_WETH_MAX_ENTRY || 0.01);
const PAPER_USDG_MAX_ENTRY = Number(process.env.PAPER_USDG_MAX_ENTRY || 100);
const PAPER_CYCLE_MS = Number(process.env.PAPER_CYCLE_MS || 30_000);
const STATE_FILE = String(process.env.STATE_FILE || "");
const STATE_SAVE_MS = Number(process.env.STATE_SAVE_MS || 30_000);
const V3_BOUNDARY_CACHE_MS = Number(process.env.V3_BOUNDARY_CACHE_MS || 30_000);
const CANDIDATE_CACHE_MS = Number(process.env.CANDIDATE_CACHE_MS || 15_000);
const SHADOW_RECORDING_PAUSED = false;
const PAPER_ENTRIES_PAUSED = true;

const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
const UNISWAP_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const pools = new Map();
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
let logDeduplicator = new LogDeduplicator();
let positionLiveness = new PositionLiveness();
let nextPollDelayMs = POLL_MS;
let lastPaperCycleAt = 0;
let candidateCache = null;
let candidatePromise = null;
const paperAutomation = { cycles: 0, entries: 0, exits: 0, lastError: null, recentDecisions: [] };
const shadowEvaluator = new ShadowEvaluator();
const metrics = {
  startedAt: Date.now(), latestBlock: 0, blockTimestamp: 0, cursor: 0,
  successfulPolls: 0, failedPolls: 0, lastError: null,
  backfill: { active: false, from: 0, to: 0, current: 0 },
  v2Pools: 0, v3Pools: 0, swaps: 0, rpcLatencyMs: 0,
};
const persistence = {
  enabled: Boolean(STATE_FILE), restored: false, restoredCursor: null, restoredPoolCount: 0,
  lastSavedAt: null, lastAttemptAt: 0, lastError: null,
  writeBlocked: false, automationBlockedReason: null,
  stateFile: STATE_FILE ? "configured" : null,
};

function persistedState() {
  return {
    cursor: metrics.cursor,
    pools: [...pools.values()],
    paperBooks: Object.fromEntries([...paperBooks].map(([quoteToken, book]) => [
      quoteToken, { symbol: book.symbol, state: book.portfolio.serialize() },
    ])),
    paperAutomation,
    shadow: shadowEvaluator.serialize(),
    processedLogs: logDeduplicator.serialize(),
    positionLiveness: positionLiveness.serialize(),
  };
}

async function restoreState() {
  if (!STATE_FILE) return;
  try {
    const state = await loadJsonState(STATE_FILE);
    if (!state) return;
    for (const savedPool of (state.pools || []).slice(0, MAX_POOLS)) {
      const pool = {
        ...savedPool,
        recentBlocks: Array.isArray(savedPool.recentBlocks)
          ? savedPool.recentBlocks.filter((bucket) => Number.isFinite(Number(bucket.timestampMs)))
          : [],
      };
      delete pool.recent;
      pools.set(pool.address, pool);
    }
    metrics.cursor = Number(state.cursor) || 0;
    metrics.v2Pools = [...pools.values()].filter((pool) => pool.version === "v2").length;
    metrics.v3Pools = [...pools.values()].filter((pool) => pool.version === "v3").length;
    metrics.swaps = [...pools.values()].reduce((sum, pool) => sum + (Number(pool.swapCount) || 0), 0);
    if (state.paperBooks) {
      for (const [quoteToken, saved] of Object.entries(state.paperBooks)) {
        const book = paperBooks.get(quoteToken.toLowerCase());
        if (book && saved?.state) book.portfolio.restore(saved.state);
      }
    }
    if (state.paperAutomation) Object.assign(paperAutomation, state.paperAutomation);
    if (state.shadow) shadowEvaluator.restore(state.shadow);
    logDeduplicator = new LogDeduplicator({ entries: state.processedLogs || [] });
    positionLiveness = new PositionLiveness({ state: state.positionLiveness || {} });
    persistence.restored = true;
    persistence.restoredCursor = metrics.cursor;
    persistence.restoredPoolCount = pools.size;
    persistence.lastSavedAt = state.savedAt;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.message : String(error);
    persistence.writeBlocked = true;
    persistence.automationBlockedReason = "state-restore-failed";
    console.error(`State restore failed; persistence and paper automation blocked: ${persistence.lastError}`);
  }
}

async function persistState(force = false) {
  if (!STATE_FILE || persistence.writeBlocked) return;
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

const tokenMeta = createTokenMetadataLoader({
  call: (address, data) => rpc("eth_call", [{ to: address, data }, "latest"]),
  pinned: ROBINHOOD.quoteTokens,
});

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
  pools.set(pool.address, {
    ...pool,
    swapCount: 0,
    lastSwapBlock: 0,
    lastSwapTimestampMs: 0,
    recentBlocks: [],
  });
  if (pool.version === "v2") metrics.v2Pools += 1;
  else metrics.v3Pools += 1;
}

async function discover(from, to, rangeTimes) {
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
        discoveryTimestampMs: estimateBlockTimestamp(log.blockNumber, rangeTimes),
      });
    }
  }
}

function recordSwap(log, timestampMs) {
  const pool = pools.get(String(log.address).toLowerCase());
  if (!pool) return;
  if (!logDeduplicator.accept(log)) return;
  pool.swapCount += 1;
  pool.lastSwapBlock = log.blockNumber;
  pool.lastSwapTimestampMs = timestampMs;
  const blocks = pool.recentBlocks || (pool.recentBlocks = []);
  const last = blocks.at(-1);
  if (last?.blockNumber === log.blockNumber) last.count += 1;
  else blocks.push({ blockNumber: log.blockNumber, timestampMs, count: 1 });
  const historyFloor = timestampMs - SIGNAL_HISTORY_MS;
  while (blocks.length && blocks[0].timestampMs < historyFloor) blocks.shift();
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

async function observeSwaps(from, to, rangeTimes) {
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
      logs.forEach((log) => recordSwap(
        log, estimateBlockTimestamp(log.blockNumber, rangeTimes),
      ));
    }
  }
}

async function blockRangeTimes(from, to) {
  const [first, last] = await Promise.all([
    rpc("eth_getBlockByNumber", [hexBlock(from), false]),
    from === to
      ? Promise.resolve(null)
      : rpc("eth_getBlockByNumber", [hexBlock(to), false]),
  ]);
  const fromTimestampMs = intHex(first?.timestamp) * 1_000;
  const toTimestampMs = (last ? intHex(last.timestamp) : intHex(first?.timestamp)) * 1_000;
  if (!Number.isFinite(fromTimestampMs) || fromTimestampMs <= 0
      || !Number.isFinite(toTimestampMs) || toTimestampMs <= 0) {
    throw new Error("block-timestamp-unavailable");
  }
  return { from, to, fromTimestampMs, toTimestampMs };
}

function estimateBlockTimestamp(blockNumber, rangeTimes) {
  if (rangeTimes.to <= rangeTimes.from) return rangeTimes.fromTimestampMs;
  const ratio = (blockNumber - rangeTimes.from) / (rangeTimes.to - rangeTimes.from);
  return Math.round(
    rangeTimes.fromTimestampMs
      + ratio * (rangeTimes.toTimestampMs - rangeTimes.fromTimestampMs),
  );
}

async function scanRange(from, to) {
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, to);
    const rangeTimes = await blockRangeTimes(start, end);
    await discover(start, end, rangeTimes);
    await observeSwaps(start, end, rangeTimes);
    logDeduplicator.prune(end);
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
    if (ready.readyForPaper && !persistence.automationBlockedReason
        && Date.now() - lastPaperCycleAt >= PAPER_CYCLE_MS) {
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
    setTimeout(poll, nextPollDelayMs);
  }
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
    mode: PAPER_ENTRIES_PAUSED ? "PAPER_ENTRIES_PAUSED" : "PAPER_ONLY",
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
      method: "current-word-conservative-edge",
    },
    readiness,
    persistence,
  };
}

function signals(limit = 25) {
  const nowMs = (metrics.blockTimestamp * 1_000) || Date.now();
  return rankPools([...pools.values()], nowMs, {
    windowMs: SIGNAL_WINDOW_MS,
    baselineMs: SIGNAL_BASELINE_MS,
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

async function ensureDiscoveryTimestamp(pool) {
  if (Number.isFinite(Number(pool.discoveryTimestampMs))
      && Number(pool.discoveryTimestampMs) > 0) return Number(pool.discoveryTimestampMs);
  const block = await rpc("eth_getBlockByNumber", [hexBlock(pool.discoveryBlock), false]);
  const timestampMs = intHex(block?.timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    throw new Error("pool-discovery-timestamp-unavailable");
  }
  pool.discoveryTimestampMs = timestampMs;
  return timestampMs;
}

function plannedPaperNotional(quoteAddress) {
  const book = paperBooks.get(quoteAddress);
  if (!book) return null;
  const cash = Number(book.portfolio.snapshot().cash);
  const cap = book.symbol === "WETH" ? PAPER_WETH_MAX_ENTRY : PAPER_USDG_MAX_ENTRY;
  const notional = Math.min(cash * DEFAULT_PAPER_STRATEGY.entryCashPct / 100, cap);
  return Number.isFinite(notional) && notional > 0 ? notional : null;
}

function humanToUnits(value, decimals) {
  const precision = Math.min(Number(decimals), 12);
  const scaled = Math.floor(Number(value) * (10 ** precision));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error("invalid-token-amount");
  return BigInt(scaled) * (10n ** BigInt(Number(decimals) - precision));
}

function unitsToHuman(value, decimals) {
  const human = Number(BigInt(value)) / (10 ** Number(decimals));
  if (!Number.isFinite(human) || human <= 0) throw new Error("invalid-quote-output");
  return human;
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
    poolAgeMs: null,
    priceImpactPct: null, roundTripLossPct: null,
  };
  if (!base.quoteTokenKnown) return base;
  try {
    const discoveryTimestampMs = await ensureDiscoveryTimestamp(pool);
    base.poolAgeMs = Math.max(
      0,
      ((metrics.blockTimestamp * 1_000) || Date.now()) - discoveryTimestampMs,
    );
    const [token0Meta, token1Meta] = await Promise.all([
      tokenMeta(pool.token0), tokenMeta(pool.token1),
    ]);
    const quoteAddress = quoteIsToken0 ? pool.token0 : pool.token1;
    const quoteDecimals = quoteIsToken0 ? token0Meta.decimals : token1Meta.decimals;
    const plannedNotionalQuote = plannedPaperNotional(quoteAddress);
    if (!plannedNotionalQuote) throw new Error("paper-notional-unavailable");
    const quoteAmountIn = humanToUnits(plannedNotionalQuote, quoteDecimals);
    if (pool.version === "v2") {
      const reserves = decodeV2Reserves(await rpc("eth_call",
        [{ to: pool.address, data: "0x0902f1ac" }, "latest"]));
      const safety = evaluateV2MarketSafety(pool, {
        latestBlock: metrics.latestBlock || metrics.cursor,
        quoteTokens, reserve0: reserves.reserve0, reserve1: reserves.reserve1,
        token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
        quoteAmountIn,
      });
      return { ...safety, plannedNotionalQuote, ...auditSwapPrice({
        spotPriceQuote: safety.tokenPriceQuote, swap: pool.lastSwap, quoteIsToken0,
        token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
      }) };
    }
    const [slot0Result, liquidityResult] = await Promise.all([
      rpc("eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
    ]);
    const slot0 = decodeV3Slot0(slot0Result);
    let tickSpacing = Number(pool.tickSpacing);
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
      const tickSpacingResult = await rpc("eth_call", [{
        to: pool.address, data: "0xd0c93a7c",
      }, "latest"]);
      tickSpacing = Number(decodeUint(tickSpacingResult, "tick-spacing"));
      pool.tickSpacing = tickSpacing;
    }
    const boundaryTick = await resolveV3Boundary(
      pool, slot0.tick, tickSpacing, quoteIsToken0,
    );
    const safety = evaluateV3MarketSafety(pool, {
      latestBlock: metrics.latestBlock || metrics.cursor,
      quoteTokens, sqrtPriceX96: slot0.sqrtPriceX96, currentTick: slot0.tick,
      liquidity: decodeUint(liquidityResult, "liquidity"), boundaryTick,
      token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
      quoteAmountIn,
    });
    return { ...safety, plannedNotionalQuote, ...auditSwapPrice({
      spotPriceQuote: safety.tokenPriceQuote, swap: pool.lastSwap, quoteIsToken0,
      token0Decimals: token0Meta.decimals, token1Decimals: token1Meta.decimals,
    }) };
  } catch (error) {
    return { ...base, measurementError: error instanceof Error ? error.message : String(error) };
  }
}

async function paperExitQuote(pool, position) {
  const quoteTokens = [ROBINHOOD.weth, ROBINHOOD.usdg].map((address) => address.toLowerCase());
  const quoteIsToken0 = quoteTokens.includes(pool.token0);
  const quoteIsToken1 = quoteTokens.includes(pool.token1);
  if (quoteIsToken0 === quoteIsToken1) throw new Error("unknown-quote-token");
  const [token0Meta, token1Meta] = await Promise.all([
    tokenMeta(pool.token0), tokenMeta(pool.token1),
  ]);
  const quoteToken = quoteIsToken0 ? pool.token0 : pool.token1;
  const quoteDecimals = quoteIsToken0 ? token0Meta.decimals : token1Meta.decimals;
  const baseDecimals = quoteIsToken0 ? token1Meta.decimals : token0Meta.decimals;
  const baseAmountIn = humanToUnits(position.quantity, baseDecimals);
  let amountOut;
  let priceImpactPct = null;
  if (pool.version === "v2") {
    const { reserve0, reserve1 } = decodeV2Reserves(await rpc(
      "eth_call", [{ to: pool.address, data: "0x0902f1ac" }, "latest"],
    ));
    const reserveIn = quoteIsToken0 ? reserve1 : reserve0;
    const reserveOut = quoteIsToken0 ? reserve0 : reserve1;
    if (reserveIn <= 0n || reserveOut <= 0n) {
      return { quoteToken, liquidityZero: true };
    }
    const fill = quoteV2({
      reserveIn,
      reserveOut,
      amountIn: baseAmountIn,
      feeBps: pool.dex === "pancakeswap" ? 25 : 30,
    });
    amountOut = fill.amountOut;
    priceImpactPct = fill.priceImpactBps / 100;
  } else {
    const [slot0Result, liquidityResult] = await Promise.all([
      rpc("eth_call", [{ to: pool.address, data: "0x3850c7bd" }, "latest"]),
      rpc("eth_call", [{ to: pool.address, data: "0x1a686502" }, "latest"]),
    ]);
    const slot0 = decodeV3Slot0(slot0Result);
    const liquidity = decodeUint(liquidityResult, "liquidity");
    if (liquidity <= 0n) return { quoteToken, liquidityZero: true };
    let tickSpacing = Number(pool.tickSpacing);
    if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
      tickSpacing = Number(decodeUint(await rpc("eth_call", [{
        to: pool.address, data: "0xd0c93a7c",
      }, "latest"]), "tick-spacing"));
      pool.tickSpacing = tickSpacing;
    }
    const zeroForOne = !quoteIsToken0;
    const boundaryTick = await resolveV3Boundary(
      pool, slot0.tick, tickSpacing, zeroForOne,
    );
    const fill = quoteV3WithinTick({
      sqrtPriceX96: slot0.sqrtPriceX96,
      liquidity,
      amountIn: baseAmountIn,
      zeroForOne,
      feeBps: Math.ceil(Number(pool.fee) / 100),
    });
    if (!staysWithinTickBoundary({
      startSqrtPriceX96: slot0.sqrtPriceX96,
      endSqrtPriceX96: fill.nextSqrtPriceX96,
      boundaryTick,
      zeroForOne,
    })) throw new Error("v3-exit-crosses-tick-boundary");
    amountOut = fill.amountOut;
  }
  const proceeds = unitsToHuman(amountOut, quoteDecimals);
  return {
    quoteToken,
    proceeds,
    executionPrice: proceeds / Number(position.quantity),
    priceImpactPct,
    baseAmountIn: baseAmountIn.toString(),
    quoteAmountOut: amountOut.toString(),
  };
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

function poolFeeRate(pool) {
  if (pool.version === "v3") return Number(pool.fee || 3000) / 1_000_000;
  return pool.dex === "pancakeswap" ? 0.0025 : 0.003;
}

function paperEntryAudit(candidate, feeRate) {
  return {
    block: metrics.latestBlock,
    signal: candidate.signal?.state,
    version: candidate.version,
    venue: candidate.dex,
    score: candidate.signal?.score,
    recentSwaps: candidate.signal?.swapsCurrentWindow,
    acceleration: candidate.signal?.acceleration,
    priceImpactPct: candidate.marketSafety?.priceImpactPct,
    executionCostPct: candidate.marketSafety?.executionCostPct,
    plannedNotionalQuote: candidate.marketSafety?.plannedNotionalQuote,
    lastSwapPriceQuote: candidate.marketSafety?.lastSwapPriceQuote,
    spotVsLastSwapPct: candidate.marketSafety?.spotVsLastSwapPct,
    currentTick: candidate.marketSafety?.currentTick,
    boundaryTick: candidate.marketSafety?.boundaryTick,
    feeRate,
  };
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
        const key = `${quoteToken}:${position.pool}`;
        const pool = pools.get(position.pool);
        let exit = null;
        let livenessReason = null;
        if (!pool) {
          livenessReason = positionLiveness.observe(key, "unavailable");
        } else {
          try {
            exit = await paperExitQuote(pool, position);
            livenessReason = positionLiveness.observe(
              key, exit.liquidityZero ? "zero-liquidity" : "healthy",
            );
          } catch (error) {
            livenessReason = positionLiveness.observe(key, "unavailable");
            rememberPaperDecision({
              type: "mark-unavailable",
              quote: book.symbol,
              pool: position.pool,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (livenessReason) {
          book.portfolio.close({
            pool: position.pool,
            price: 0,
            proceeds: 0,
            fee: 0,
            reason: livenessReason,
            audit: { block: metrics.latestBlock, reason: livenessReason },
          });
          paperAutomation.exits += 1;
          rememberPaperDecision({
            type: "exit", quote: book.symbol, pool: position.pool,
            reason: livenessReason, price: 0, proceeds: 0,
          });
          continue;
        }
        if (!exit || exit.liquidityZero
            || exit.quoteToken !== quoteToken
            || !Number.isFinite(exit.executionPrice)) continue;
        const marked = book.portfolio.mark(position.pool, exit.executionPrice);
        const reason = paperExitReason(marked);
        if (reason) {
          const feeRate = poolFeeRate(pool);
          const fee = exit.proceeds * feeRate;
          book.portfolio.close({
            pool: position.pool,
            price: exit.executionPrice,
            proceeds: exit.proceeds,
            fee,
            reason,
            audit: {
              block: metrics.latestBlock,
              reason,
              feeRate,
              returnPct: marked.returnPct,
              peakReturnPct: marked.peakReturnPct,
              priceImpactPct: exit.priceImpactPct,
              quoteAmountOut: exit.quoteAmountOut,
            },
          });
          paperAutomation.exits += 1;
          rememberPaperDecision({
            type: "exit", quote: book.symbol, pool: position.pool,
            reason, price: exit.executionPrice, proceeds: exit.proceeds,
          });
        }
      }
    }

    if (SHADOW_RECORDING_PAUSED && PAPER_ENTRIES_PAUSED) {
      paperAutomation.lastError = null;
      return;
    }

    const measured = await candidates(10);
    const rankedAddresses = new Set(measured.map((candidate) => candidate.address));
    const pendingPools = shadowEvaluator.pendingPoolAddresses()
      .filter((address) => !rankedAddresses.has(address))
      .map((address) => pools.get(address))
      .filter(Boolean);
    const pendingMeasurements = await Promise.all(pendingPools.map(async (pool) => ({
      address: pool.address,
      marketSafety: await marketSafety(pool),
    })));
    if (!SHADOW_RECORDING_PAUSED) {
      shadowEvaluator.resolve([...measured, ...pendingMeasurements]);
      shadowEvaluator.record(measured);
    }
    if (PAPER_ENTRIES_PAUSED) {
      paperAutomation.lastError = null;
      return;
    }
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
      const paperState = book.portfolio.serialize();
      const circuitFailures = paperCircuitFailures(analyzePaperTrades({
        initialCash: paperState.initialCash, trades: paperState.trades,
      }), policy);
      if (circuitFailures.length) {
        rememberPaperDecision({ type: "reject", quote: book.symbol,
          pool: candidate.address, reasons: circuitFailures });
        continue;
      }
      const plan = planPaperEntry(candidate, book.portfolio.snapshot(), policy);
      if (!plan.approved) {
        rememberPaperDecision({ type: "reject", quote: book.symbol,
          pool: candidate.address, reasons: plan.failures });
        continue;
      }
      const feeRate = poolFeeRate(candidate);
      const fee = plan.order.notional * feeRate;
      book.portfolio.open({
        ...plan.order, fee, audit: paperEntryAudit(candidate, feeRate),
      });
      paperAutomation.entries += 1;
      rememberPaperDecision({ type: "entry", quote: book.symbol, pool: candidate.address,
        price: plan.order.price, notional: plan.order.notional, fee });
    }
    paperAutomation.lastError = null;
  } catch (error) {
    paperAutomation.lastError = error instanceof Error ? error.message : String(error);
  }
}

function paperBookStatus(book) {
  const state = book.portfolio.serialize();
  return {
    quote: book.symbol,
    ...book.portfolio.snapshot(),
    analytics: analyzePaperTrades({
      initialCash: state.initialCash, trades: state.trades,
    }),
    recentTrades: state.trades.slice(-20),
  };
}

function paperStatus() {
  return {
    mode: "PAPER_ONLY",
    newEntriesPaused: PAPER_ENTRIES_PAUSED,
    pauseReason: persistence.automationBlockedReason
      || (PAPER_ENTRIES_PAUSED ? "paper-ledger-review" : null),
    shadowRecordingPaused: SHADOW_RECORDING_PAUSED,
    automationBlockedReason: persistence.automationBlockedReason,
    books: Object.fromEntries([...paperBooks.values()].map((book) => [
      book.symbol, paperBookStatus(book),
    ])),
    automation: { ...paperAutomation, cycleIntervalMs: PAPER_CYCLE_MS,
      lastCycleAt: lastPaperCycleAt || null },
    shadow: shadowEvaluator.snapshot(),
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
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Robinhood Observer</title><style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:auto;max-width:720px;padding:18px}h1{font-size:23px}.warn{background:#713f12;padding:12px;border-radius:10px}.grid,article{display:grid;gap:9px}section,article{background:#1f2937;margin:12px 0;padding:15px;border-radius:12px}article span,small{color:#9ca3af}code{color:#86efac}</style><h1>Robinhood Chain Observer</h1><p class="warn">PAPER MEASUREMENT REPAIR<br>New entries are paused; state persistence is monitored.</p><section class="grid"><b>Chain <code>4663</code></b><span>Latest block: ${s.latestBlock.toLocaleString()}</span><span>Cursor: ${s.cursor.toLocaleString()}</span><span>Pools: ${pools.size} (${metrics.v2Pools} V2 / ${metrics.v3Pools} V3)</span><span>Swaps observed: ${metrics.swaps}</span><span>Polls: ${metrics.successfulPolls} successful / ${metrics.failedPolls} failed</span><span>Last error: ${esc(metrics.lastError || "none")}</span><span>Paper readiness: ${s.readiness.readyForPaper ? "ready" : esc(s.readiness.reasons.join(", "))}</span></section><h2>Most active pools</h2>${cards.join("") || "<section>Waiting for pool events in the observation window.</section>"}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") { res.writeHead(405).end("Method Not Allowed"); return; }
    if (req.url === "/health") return json(res, { status: "ok", ...snapshot() });
    if (req.url === "/api/scanner") return json(res, snapshot());
    if (req.url === "/api/pools") return json(res, { total: pools.size, pools: [...pools.values()].slice(0, 100) });
    if (req.url === "/api/signals") return json(res, { mode: "PAPER_SIGNAL_ONLY", signals: signals() });
    if (req.url === "/api/candidates") return json(res, { mode: "PAPER_FAIL_CLOSED", candidates: await candidates() });
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await persistState(true);
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
