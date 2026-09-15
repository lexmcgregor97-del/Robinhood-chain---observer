import test from "node:test";
import assert from "node:assert/strict";
import { createLiveWorkerRuntime } from "./live-worker-runtime.js";
import { expectedTurnkeySigningPolicies } from "./turnkey-signing-probe.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const UUIDS = [1, 2, 3, 4].map((n) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const env = { ATLAS_EXECUTION_MODE: "MICRO_MAINNET", MICRO_MAINNET_ENABLED: "true",
  TURNKEY_SIGNING_ORGANIZATION_ID: UUIDS[0], TURNKEY_ORGANIZATION_ID: UUIDS[0],
  TURNKEY_SIGNING_WALLET_ADDRESS: WALLET, TURNKEY_WALLET_ADDRESS: WALLET,
  TURNKEY_SIGNING_BUY_POLICY_ID: UUIDS[1], TURNKEY_SIGNING_SELL_POLICY_ID: UUIDS[2],
  TURNKEY_SIGNING_APPROVAL_POLICY_ID: UUIDS[3],
  TURNKEY_SIGNING_API_PUBLIC_KEY: `02${"1".repeat(64)}`,
  TURNKEY_API_PUBLIC_KEY: `02${"2".repeat(64)}`,
  MICRO_MAINNET_V2_ROUTERS: ROUTER, MICRO_MAINNET_MAX_WETH_PER_TX_WEI: "100",
  MICRO_MAINNET_MAX_WETH_DAILY_WEI: "200", MICRO_MAINNET_MAX_GAS: "400000",
  MICRO_MAINNET_MAX_FEE_PER_GAS_WEI: "2000000000",
  MICRO_MAINNET_CONFIRMATION: `ENABLE_ATLAS_MICRO_MAINNET:4663:${WALLET}`,
  ATLAS_OBSERVER_URL: "https://atlas.example", LIVE_WORKER_STATE_FILE: "/data/live.json",
  LIVE_WORKER_EVIDENCE_FILE: "/data/live.jsonl", LIVE_WORKER_V2_ROUTER_ADDRESS: ROUTER,
  LIVE_WORKER_BUY_AMOUNT_WEI: "10", LIVE_WORKER_MAX_ALLOWANCE_WEI: "100",
  LIVE_WORKER_MIN_NATIVE_BALANCE_WEI: "1" };

test("disconnected runtime cannot touch RPC, storage, or Turnkey", async () => {
  let touched = false;
  const runtime = await createLiveWorkerRuntime({ env,
    fetchImpl: async () => { touched = true; throw new Error(); },
    openStore: async () => { touched = true; throw new Error(); },
    makeTurnkeyClient: () => { touched = true; throw new Error(); } });
  assert.equal(runtime.connected, false);
  assert.equal((await runtime.runOnce()).status, "disabled");
  assert.equal(touched, false);
});

test("both ceremonies still fail before RPC without the worker signing key", async () => {
  await assert.rejects(createLiveWorkerRuntime({ env: { ...env,
    LIVE_WORKER_SUBMISSION_CONNECTED: "true", LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "true",
    LIVE_WORKER_CONFIRMATION: `CONNECT_ATLAS_PRIVATE_WORKER:4663:${WALLET}` } }),
  /live-worker-signing-private-key-required/);
});

test("connected runtime verifies chain, store, and exact live policy before exposure", async () => {
  let accountCreated = false;
  const armed = { ...env, LIVE_WORKER_SUBMISSION_CONNECTED: "true",
    LIVE_WORKER_AUTOMATIC_SUBMISSION_ENABLED: "true",
    LIVE_WORKER_CONFIRMATION: `CONNECT_ATLAS_PRIVATE_WORKER:4663:${WALLET}`,
    TURNKEY_SIGNING_API_PRIVATE_KEY: "sealed-secret", RPC_URL: "https://rpc.example" };
  const publicConfig = (await createLiveWorkerRuntime({ env })).config;
  const signingUserId = "00000000-0000-7000-8000-000000000005";
  const expected = expectedTurnkeySigningPolicies(publicConfig, signingUserId);
  const policies = Object.entries(expected).map(([kind, policy]) => ({ ...policy,
    policyId: publicConfig.policyIds[kind] }));
  const client = { getWhoami: async () => ({ userId: signingUserId }),
    getOrganizationConfigs: async () => ({ configs: { quorum: { userIds: [] } } }),
    getPolicies: async () => ({ policies }),
    getUser: async () => ({ user: { apiKeys: [{ credential: {
      publicKey: publicConfig.apiPublicKey } }], userTags: [] } }) };
  const journal = { pending: () => [], get: () => null };
  const runtime = await createLiveWorkerRuntime({ env: armed,
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://rpc.example");
      assert.match(request.body, /eth_chainId/);
      return { ok: true, json: async () => ({ result: "0x1237" }) };
    }, makeTurnkeyClient: () => client,
    makeSigningAccount: async () => {
      accountCreated = true;
      return { address: WALLET, signTransaction: async () => "0x12" };
    }, openStore: async () => ({ journal,
      nonceLane: { snapshot: () => ({ lanes: [] }), finalize: async () => false },
      spendLedger: { snapshot: () => ({ spent: {} }) } }) });
  assert.equal(runtime.connected, true);
  assert.equal(runtime.automatic, true);
  assert.equal(accountCreated, true);
});
