const blockHex = (value) => `0x${Number(value).toString(16)}`;

const isProviderLimit = (error) => /RPC HTTP 400(?:\s|\(|$)/.test(String(error?.message || error));

export async function fetchLogsAdaptive({ request, from, to, address, topics }) {
  try {
    return await request("eth_getLogs", [{
      fromBlock: blockHex(from), toBlock: blockHex(to), address, topics,
    }]);
  } catch (error) {
    if (!isProviderLimit(error)) throw error;
    if (from < to) {
      const middle = Math.floor((from + to) / 2);
      const [left, right] = await Promise.all([
        fetchLogsAdaptive({ request, from, to: middle, address, topics }),
        fetchLogsAdaptive({ request, from: middle + 1, to, address, topics }),
      ]);
      return [...left, ...right];
    }
    if (Array.isArray(address) && address.length > 1) {
      const middle = Math.ceil(address.length / 2);
      const [left, right] = await Promise.all([
        fetchLogsAdaptive({ request, from, to, address: address.slice(0, middle), topics }),
        fetchLogsAdaptive({ request, from, to, address: address.slice(middle), topics }),
      ]);
      return [...left, ...right];
    }
    throw error;
  }
}
