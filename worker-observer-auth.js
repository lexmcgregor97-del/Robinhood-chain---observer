import { createHash, timingSafeEqual } from "node:crypto";

export function workerObserverAuthorized(authorization, bearerToken) {
  const token = String(bearerToken || "");
  if (token.length < 32) return false;
  const supplied = createHash("sha256").update(String(authorization || "")).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(supplied, expected);
}

