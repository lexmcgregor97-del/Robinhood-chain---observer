export function assessReadiness({ latestBlock, cursor, backfillActive, lastError }) {
  latestBlock = Number(latestBlock) || 0;
  cursor = Number(cursor) || 0;
  const lagBlocks = latestBlock > 0 ? Math.max(0, latestBlock - cursor) : null;
  const synchronized = latestBlock > 0 && !backfillActive && lagBlocks === 0;
  const rpcHealthy = !lastError;
  const reasons = [];
  if (latestBlock <= 0) reasons.push("latest-block-unavailable");
  if (backfillActive) reasons.push("backfill-active");
  if (lagBlocks !== null && lagBlocks > 0) reasons.push("scanner-behind");
  if (!rpcHealthy) reasons.push("rpc-error");
  return {
    synchronized,
    rpcHealthy,
    readyForPaper: synchronized && rpcHealthy,
    lagBlocks,
    reasons,
  };
}
