import test from "node:test";
import assert from "node:assert/strict";
import { probeTurnkeyWallet, turnkeyConfigFromEnv } from "./turnkey-probe.js";

const config = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  walletId: "22222222-2222-4222-8222-222222222222",
  walletAddress: "0x3333333333333333333333333333333333333333",
};

test("reports missing Turnkey configuration without exposing values", () => {
  const result = turnkeyConfigFromEnv({ TURNKEY_ORGANIZATION_ID: config.organizationId });
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes("apiPrivateKey"));
  assert.equal(JSON.stringify(result.missing).includes(config.organizationId), false);
});

test("verifies the configured wallet and address through a read-only query", async () => {
  const result = await probeTurnkeyWallet({ config, getWalletAccounts: async () => ({
    accounts: [{ walletId: config.walletId, walletAccountId: "account-id",
      address: config.walletAddress.toUpperCase().replace("0X", "0x") }],
  }) });
  assert.deepEqual(result, { authenticated: true, walletVisible: true, addressMatch: true,
    walletAccountId: "account-id", accountCount: 1 });
});
