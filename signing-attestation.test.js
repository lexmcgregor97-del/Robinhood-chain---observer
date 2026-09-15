import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  createSigningAttestation, signingConfigFingerprint, summarizeBehavioralMatrix,
  verifySigningAttestation,
} from "./signing-attestation.js";

const config = { organizationId: "org", walletAddress: "0x1111111111111111111111111111111111111111",
  policyIds: { buy: "buy", sell: "sell", approval: "approval" }, apiPublicKey: "02ab",
  allowedRouters: ["0x2222222222222222222222222222222222222222"],
  maxPerTransactionWei: "1", maxDailyWei: "3", maxGas: "400000",
  maxFeePerGasWei: "2000000000" };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" } });
const matrix = summarizeBehavioralMatrix({ runAt: 1_000,
  allows: ["allow-buy", "allow-sell", "allow-approve", "allow-reset"],
  denials: Array.from({ length: 12 }, (_, index) => `deny-${index}`) }, { now: 1_500 });

test("signs an expiring attestation bound to the complete public execution config", () => {
  const document = createSigningAttestation({ config, signingUserId: "signer",
    observerUserId: "observer", behavioralMatrix: matrix,
    privateKeyPem: privateKey, issuedAt: 1_000, expiresAt: 2_000 });
  const result = verifySigningAttestation({ document, config, publicKeyPem: publicKey, now: 1_500 });
  assert.equal(result.verified, true);
  assert.equal(result.claims.configFingerprint, signingConfigFingerprint(config));
});

test("rejects expiry, config drift, signature changes, and one user holding both roles", () => {
  const document = createSigningAttestation({ config, signingUserId: "signer",
    observerUserId: "observer", behavioralMatrix: matrix,
    privateKeyPem: privateKey, issuedAt: 1_000, expiresAt: 2_000 });
  assert.ok(verifySigningAttestation({ document, config, publicKeyPem: publicKey, now: 2_001 })
    .failures.includes("signing-attestation-expired"));
  assert.ok(verifySigningAttestation({ document, config: { ...config, maxDailyWei: "4" },
    publicKeyPem: publicKey, now: 1_500 }).failures.includes("signing-attestation-config-mismatch"));
  assert.equal(verifySigningAttestation({ document: { ...document, signature: "AAAA" }, config,
    publicKeyPem: publicKey, now: 1_500 }).verified, false);
  assert.throws(() => createSigningAttestation({ config, signingUserId: "same",
    observerUserId: "same", behavioralMatrix: matrix,
    privateKeyPem: privateKey }), /invalid-signing-attestation-input/);
});

test("behavioral matrix summary requires four allows and twelve unique denials", () => {
  assert.throws(() => summarizeBehavioralMatrix({ runAt: 1_000,
    allows: ["a"], denials: ["d"] }, { now: 1_500 }), /results-incomplete/);
  assert.throws(() => createSigningAttestation({ config, signingUserId: "signer",
    observerUserId: "observer", privateKeyPem: privateKey }), /matrix-attestation-required/);
});
