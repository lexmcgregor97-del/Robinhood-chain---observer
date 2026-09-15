import { encodeAbiParameters, getAddress, keccak256 } from "viem";

const DIGEST_TYPES = Object.freeze([
  { type: "uint256" }, { type: "address" }, { type: "address" },
  { type: "bytes" }, { type: "uint256" },
]);

export function executionIntentTransactionDigest({ chainId, from, to, data, value }) {
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0
      || typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error("execution-intent-digest-input-invalid");
  }
  let amount;
  try { amount = BigInt(value); } catch { throw new Error("execution-intent-digest-input-invalid"); }
  if (amount < 0n) throw new Error("execution-intent-digest-input-invalid");
  try {
    return keccak256(encodeAbiParameters(DIGEST_TYPES, [
      BigInt(chainId), getAddress(from), getAddress(to), data, amount,
    ]));
  } catch {
    throw new Error("execution-intent-digest-input-invalid");
  }
}
