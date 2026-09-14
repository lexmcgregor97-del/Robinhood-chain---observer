const Q96_NUMBER = 2 ** 96;

export function compressTick(tick, tickSpacing) {
  tick = Number(tick);
  tickSpacing = Number(tickSpacing);
  if (!Number.isInteger(tick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("invalid-tick-spacing");
  }
  return Math.floor(tick / tickSpacing);
}

export function bitmapPosition(compressedTick) {
  const wordPos = Math.floor(Number(compressedTick) / 256);
  const bitPos = ((Number(compressedTick) % 256) + 256) % 256;
  return { wordPos, bitPos };
}

export function encodeInt16Call(selector, value) {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error("invalid-selector");
  value = Number(value);
  if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new Error("int16-out-of-range");
  const encoded = value < 0 ? (1n << 256n) + BigInt(value) : BigInt(value);
  return selector + encoded.toString(16).padStart(64, "0");
}

const highestBit = (value) => {
  let bit = -1;
  while (value > 0n) { value >>= 1n; bit += 1; }
  return bit;
};

const lowestBit = (value) => {
  let bit = 0;
  while ((value & 1n) === 0n) { value >>= 1n; bit += 1; }
  return bit;
};

export function findInitializedTickInWord({
  bitmap, wordPos, currentCompressedTick, tickSpacing, zeroForOne,
}) {
  bitmap = BigInt(bitmap);
  const { bitPos } = bitmapPosition(currentCompressedTick);
  let selectedBit;
  if (zeroForOne) {
    const mask = (1n << BigInt(bitPos + 1)) - 1n;
    const masked = bitmap & mask;
    if (masked === 0n) return null;
    selectedBit = highestBit(masked);
  } else {
    const mask = ((1n << 256n) - 1n) ^ ((1n << BigInt(bitPos + 1)) - 1n);
    const masked = bitmap & mask;
    if (masked === 0n) return null;
    selectedBit = lowestBit(masked);
  }
  return (Number(wordPos) * 256 + selectedBit) * Number(tickSpacing);
}

export function findInitializedTickInWholeWord({ bitmap, wordPos, tickSpacing, zeroForOne }) {
  bitmap = BigInt(bitmap);
  if (bitmap === 0n) return null;
  const selectedBit = zeroForOne ? highestBit(bitmap) : lowestBit(bitmap);
  return (Number(wordPos) * 256 + selectedBit) * Number(tickSpacing);
}

export function approximateSqrtRatioAtTick(tick) {
  tick = Number(tick);
  if (!Number.isInteger(tick) || tick < -887272 || tick > 887272) throw new Error("tick-out-of-range");
  const ratio = (1.0001 ** (tick / 2)) * Q96_NUMBER;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("invalid-tick-ratio");
  return BigInt(Math.floor(ratio));
}

export function staysWithinTickBoundary({
  startSqrtPriceX96, endSqrtPriceX96, boundaryTick, zeroForOne, safetyBufferBps = 1,
}) {
  const start = BigInt(startSqrtPriceX96);
  const end = BigInt(endSqrtPriceX96);
  const boundary = approximateSqrtRatioAtTick(boundaryTick);
  const buffer = BigInt(safetyBufferBps);
  if (zeroForOne) {
    const conservativeBoundary = boundary * (10_000n + buffer) / 10_000n;
    return end > conservativeBoundary && end < start;
  }
  const conservativeBoundary = boundary * (10_000n - buffer) / 10_000n;
  return end < conservativeBoundary && end > start;
}
