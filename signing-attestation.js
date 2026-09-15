import { createHash, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const VERSION = 1;
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signingConfigFingerprint(config) {
  const publicConfig = {
    organizationId: config.organizationId,
    walletAddress: config.walletAddress,
    policyIds: config.policyIds,
    apiPublicKey: config.apiPublicKey,
    allowedRouters: [...config.allowedRouters],
    maxPerTransactionWei: config.maxPerTransactionWei,
    maxDailyWei: config.maxDailyWei,
    maxGas: config.maxGas,
    maxFeePerGasWei: config.maxFeePerGasWei,
  };
  return createHash("sha256").update(canonical(publicConfig)).digest("hex");
}

export function createSigningAttestation({
  config, signingUserId, observerUserId, privateKeyPem,
  issuedAt = Date.now(), expiresAt = issuedAt + DEFAULT_MAX_LIFETIME_MS,
} = {}) {
  if (!privateKeyPem || !signingUserId || !observerUserId || signingUserId === observerUserId) {
    throw new Error("invalid-signing-attestation-input");
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > DEFAULT_MAX_LIFETIME_MS) {
    throw new Error("invalid-signing-attestation-window");
  }
  const claims = Object.freeze({ version: VERSION, issuedAt, expiresAt,
    configFingerprint: signingConfigFingerprint(config),
    signingUserId, observerUserId, verified: true });
  const signature = sign("sha256", Buffer.from(canonical(claims)), privateKeyPem).toString("base64");
  return Object.freeze({ claims, signature });
}

export function verifySigningAttestation({ document, config, publicKeyPem, now = Date.now() } = {}) {
  const failures = [];
  const claims = document?.claims;
  if (!claims || claims.version !== VERSION || document?.signature == null) {
    failures.push("signing-attestation-malformed");
  }
  if (claims) {
    if (claims.verified !== true) failures.push("signing-attestation-not-verified");
    if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
        || claims.expiresAt <= claims.issuedAt
        || claims.expiresAt - claims.issuedAt > DEFAULT_MAX_LIFETIME_MS) {
      failures.push("signing-attestation-window-invalid");
    } else {
      if (claims.issuedAt > now + 5 * 60_000) failures.push("signing-attestation-from-future");
      if (claims.expiresAt <= now) failures.push("signing-attestation-expired");
    }
    if (claims.signingUserId === claims.observerUserId) failures.push("signing-users-not-distinct");
    if (claims.configFingerprint !== signingConfigFingerprint(config)) {
      failures.push("signing-attestation-config-mismatch");
    }
  }
  if (!publicKeyPem) failures.push("signing-attestation-public-key-required");
  if (!failures.length) {
    try {
      if (!verify("sha256", Buffer.from(canonical(claims)), publicKeyPem,
        Buffer.from(document.signature, "base64"))) failures.push("signing-attestation-signature-invalid");
    } catch {
      failures.push("signing-attestation-signature-invalid");
    }
  }
  return Object.freeze({ verified: failures.length === 0,
    claims: failures.length === 0 ? Object.freeze({ ...claims }) : null,
    failures: Object.freeze(failures) });
}

export async function writeSigningAttestation(path, document) {
  if (!path) throw new Error("signing-attestation-path-required");
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

export async function readSigningAttestation(path) {
  if (!path) throw new Error("signing-attestation-path-required");
  return JSON.parse(await readFile(path, "utf8"));
}
