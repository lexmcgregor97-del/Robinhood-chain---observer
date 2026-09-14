const blockHex = (value) => `0x${Number(value).toString(16)}`;

const isProviderLimit = (error) => /RPC HTTP 400(?:\s|\(|$)/.test(String(error?.message || error));
const MAX_FREE_TIER_BLOCK_RANGE = 10;

export async function fetchLogsAdaptive({ request, from, to, address, topics }) {
  if (to - from + 1 > MAX_FREE_TIER_BLOCK_RANGE) {
    const logs = [];
    for (let chunkFrom = from; chunkFrom <= to; chunkFrom += MAX_FREE_TIER_BLOCK_RANGE) {
      const chunkTo = Math.min(to, chunkFrom + MAX_FREE_TIER_BLOCK_RANGE - 1);
      logs.push(...await fetchLogsAdaptive({
        request, from: chunkFrom, to: chunkTo, address, topics,
      }));
    }
    return logs;
  }
  try {
    const requestAddress = Array.isArray(address) && address.length === 1 ? address[0] : address;
    return await request("eth_getLogs", [{
      fromBlock: blockHex(from), toBlock: blockHex(to), address: requestAddress, topics,
    }]);
  } catch (error) {
    if (!isProviderLimit(error)) throw error;
    if (Array.isArray(address) && address.length > 1) {
      const middle = Math.ceil(address.length / 2);
      const [left, right] = await Promise.all([
        fetchLogsAdaptive({ request, from, to, address: address.slice(0, middle), topics }),
        fetchLogsAdaptive({ request, from, to, address: address.slice(middle), topics }),
      ]);
      return [...left, ...right];
    }
    if (from < to) {
      const middle = Math.floor((from + to) / 2);
      const [left, right] = await Promise.all([
        fetchLogsAdaptive({ request, from, to: middle, address, topics }),
        fetchLogsAdaptive({ request, from: middle + 1, to, address, topics }),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}
