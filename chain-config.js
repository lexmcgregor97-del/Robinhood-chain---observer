export const ROBINHOOD = Object.freeze({
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  quoteTokens: Object.freeze([
    Object.freeze({
      symbol: "WETH", decimals: 18,
      address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    }),
    Object.freeze({
      symbol: "USDG", decimals: 6,
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    }),
  ]),
  factories: Object.freeze([
    { dex: "pancakeswap", version: "v2", address: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E" },
    { dex: "pancakeswap", version: "v3", address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" },
    { dex: "uniswap", version: "v2", address: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f" },
    { dex: "uniswap", version: "v3", address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" },
  ]),
  approvedRouters: Object.freeze({
    uniswapV2: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
    uniswapSwapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    pancakeV2: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb",
    pancakeInfinityUniversal: "0xE28c0e44F4016b073db20cF28971CAc6ce3664D3",
  }),
});
