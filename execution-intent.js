const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})+$/;
const UINT = /^(0|[1-9][0-9]*)$/;

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`invalid-${name}`);
  return normalized;
}

export function normalizeExecutionIntent(input) {
  if (!input || typeof input !== "object") throw new Error("invalid-intent");
  const id = requiredString(input.id, "intent-id");
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new Error("invalid-intent-id");
  const chainId = Number(input.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("invalid-chain-id");
  const from = String(input.from || "").toLowerCase();
  const to = String(input.to || "").toLowerCase();
  if (!ADDRESS.test(from)) throw new Error("invalid-from");
  if (!ADDRESS.test(to)) throw new Error("invalid-to");
  const valueWei = String(input.valueWei ?? "0");
  if (!UINT.test(valueWei)) throw new Error("invalid-value-wei");
  const data = String(input.data || "").toLowerCase();
  if (!HEX_DATA.test(data) || data.length < 10) throw new Error("invalid-calldata");
  const expiresAt = Number(input.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("invalid-expiry");

  return Object.freeze({
    version: 1,
    id,
    kind: "evm-transaction",
    purpose: requiredString(input.purpose, "purpose"),
    chainId,
    from,
    to,
    valueWei,
    data,
    selector: data.slice(0, 10),
    expiresAt,
  });
}
