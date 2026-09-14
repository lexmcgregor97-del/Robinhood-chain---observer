const SYMBOL_SELECTOR = "0x95d89b41";
const DECIMALS_SELECTOR = "0x313ce567";

export function decodeTokenSymbol(result) {
  if (!result || result === "0x") throw new Error("token-symbol-unavailable");
  const hex = result.slice(2);
  try {
    if (hex.length === 64) {
      return Buffer.from(hex.replace(/00+$/, ""), "hex").toString("utf8") || "UNK";
    }
    const offset = Number.parseInt(hex.slice(0, 64), 16) * 2;
    const length = Number.parseInt(hex.slice(offset, offset + 64), 16) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + length), "hex")
      .toString("utf8") || "UNK";
  } catch {
    throw new Error("invalid-token-symbol");
  }
}

function decodeDecimals(result) {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(result || "")) {
    throw new Error("token-decimals-unavailable");
  }
  const decimals = Number.parseInt(result.slice(2, 66), 16);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("invalid-token-decimals");
  }
  return decimals;
}

export function createTokenMetadataLoader({ call, pinned = [] }) {
  if (typeof call !== "function") throw new Error("metadata-call-required");
  const cache = new Map();
  const pinnedByAddress = new Map(pinned.map((item) => [
    String(item.address).toLowerCase(),
    Object.freeze({
      symbol: String(item.symbol),
      decimals: Number(item.decimals),
      pinned: true,
    }),
  ]));
  return async function tokenMeta(address) {
    const normalized = String(address).toLowerCase();
    if (pinnedByAddress.has(normalized)) return pinnedByAddress.get(normalized);
    if (cache.has(normalized)) return cache.get(normalized);
    const [symbolResult, decimalsResult] = await Promise.all([
      call(normalized, SYMBOL_SELECTOR),
      call(normalized, DECIMALS_SELECTOR),
    ]);
    const meta = Object.freeze({
      symbol: decodeTokenSymbol(symbolResult).slice(0, 20),
      decimals: decodeDecimals(decimalsResult),
      pinned: false,
    });
    cache.set(normalized, meta);
    return meta;
  };
}
