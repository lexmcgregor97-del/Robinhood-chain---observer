import { decodeFunctionResult, encodeFunctionData, getAddress, isAddressEqual } from "viem";

const V2_PAIR_ABI = Object.freeze([
  { type: "function", name: "token0", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [
    { name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" },
    { name: "blockTimestampLast", type: "uint32" },
  ] },
]);
const ERC20_READ_ABI = Object.freeze([
  { type: "function", name: "decimals", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
]);

function quantity(value, failure) {
  if (!/^0x[0-9a-fA-F]+$/.test(String(value || ""))) throw new Error(failure);
  return BigInt(value);
}

const blockTag = (number) => `0x${BigInt(number).toString(16)}`;

async function call(rpc, to, abi, functionName, args, block) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await rpc("eth_call", [{ to, data }, block]);
  return decodeFunctionResult({ abi, functionName, data: result });
}

export async function readLiveV2ChainSnapshot({ candidate, config, rpc, now = Date.now() } = {}) {
  if (typeof rpc !== "function") throw new Error("live-chain-rpc-required");
  const poolAddress = getAddress(candidate?.address);
  const wallet = getAddress(config?.walletAddress);
  const weth = getAddress(config?.wethAddress);
  const router = getAddress(config?.routerAddress);
  const latest = quantity(await rpc("eth_blockNumber", []), "live-block-number-invalid");
  if (latest > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("live-block-number-invalid");
  const blockNumber = Number(latest);
  const pinnedBlock = blockTag(latest);
  const [block, token0, token1, reserves, wethBalance, nativeBalance, allowance] = await Promise.all([
    rpc("eth_getBlockByNumber", [pinnedBlock, false]),
    call(rpc, poolAddress, V2_PAIR_ABI, "token0", [], pinnedBlock),
    call(rpc, poolAddress, V2_PAIR_ABI, "token1", [], pinnedBlock),
    call(rpc, poolAddress, V2_PAIR_ABI, "getReserves", [], pinnedBlock),
    call(rpc, weth, ERC20_READ_ABI, "balanceOf", [wallet], pinnedBlock),
    rpc("eth_getBalance", [wallet, pinnedBlock]),
    call(rpc, weth, ERC20_READ_ABI, "allowance", [wallet, router], pinnedBlock),
  ]);
  const normalizedToken0 = getAddress(token0);
  const normalizedToken1 = getAddress(token1);
  if (isAddressEqual(normalizedToken0, normalizedToken1)) throw new Error("live-pair-token-invalid");
  const quoteIsToken0 = isAddressEqual(normalizedToken0, weth);
  const quoteIsToken1 = isAddressEqual(normalizedToken1, weth);
  if (quoteIsToken0 === quoteIsToken1) throw new Error("live-weth-pair-required");
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  if (reserve0 <= 0n || reserve1 <= 0n) throw new Error("live-reserve-invalid");
  const [token0Decimals, token1Decimals] = await Promise.all([
    call(rpc, normalizedToken0, ERC20_READ_ABI, "decimals", [], pinnedBlock),
    call(rpc, normalizedToken1, ERC20_READ_ABI, "decimals", [], pinnedBlock),
  ]);
  const timestampSeconds = quantity(block?.timestamp, "live-block-timestamp-invalid");
  if (timestampSeconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("live-block-timestamp-invalid");
  const completedHead = quantity(await rpc("eth_blockNumber", []), "live-block-number-invalid");
  if (completedHead < latest || completedHead > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("live-block-number-invalid");
  }
  return Object.freeze({ poolAddress: poolAddress.toLowerCase(),
    wethAddress: weth.toLowerCase(),
    token0: normalizedToken0.toLowerCase(), token1: normalizedToken1.toLowerCase(),
    reserve0: reserve0.toString(), reserve1: reserve1.toString(),
    reserveIn: (quoteIsToken0 ? reserve0 : reserve1).toString(),
    reserveOut: (quoteIsToken0 ? reserve1 : reserve0).toString(),
    wethBalanceWei: BigInt(wethBalance).toString(),
    nativeBalanceWei: quantity(nativeBalance, "live-native-balance-invalid").toString(),
    allowanceWei: BigInt(allowance).toString(), blockNumber, latestBlock: Number(completedHead),
    token0Decimals: Number(token0Decimals), token1Decimals: Number(token1Decimals),
    blockTimestampMs: Number(timestampSeconds) * 1_000,
    observedAt: Number(now), pinnedBlock });
}

export function createLiveCandidateInspector({
  config,
  rpc,
  assessStrategy,
  assessReadiness,
  verifySigning,
  probeSell,
  minimumNativeBalanceWei,
  maximumAllowanceWei,
  maxSnapshotAgeMs = 15_000,
  maxBlockLag = 2,
} = {}) {
  if (![assessStrategy, assessReadiness, verifySigning, probeSell]
    .every((value) => typeof value === "function")) {
    throw new Error("live-inspector-checks-required");
  }
  return async (candidate, { phase, now = Date.now(), intent = null, plan = null } = {}) => {
    const chain = await readLiveV2ChainSnapshot({ candidate, config, rpc, now });
    const strategy = await assessStrategy({ candidate, chain, phase, intent, plan, now });
    if (phase === "construction") return Object.freeze({ ...chain,
      strategyApproved: strategy?.approved === true, feeBps: strategy?.feeBps,
      strategyFailures: Object.freeze([...(strategy?.failures || [])]) });
    const [readiness, signing, sellProbe] = await Promise.all([
      assessReadiness({ candidate, chain, strategy, intent, plan, now }),
      verifySigning({ candidate, chain, strategy, intent, plan, now }),
      probeSell({ candidate, chain, strategy, intent, plan, now }),
    ]);
    return Object.freeze({ chain, strategy, readiness, signing, sellProbe,
      minimumNativeBalanceWei, maximumAllowanceWei, maxSnapshotAgeMs, maxBlockLag });
  };
}

export { ERC20_READ_ABI, V2_PAIR_ABI };
