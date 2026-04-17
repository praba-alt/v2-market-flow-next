import { Contract, JsonRpcProvider } from 'ethers';

import { getEvmRpcCandidates, isEvmChain } from '../../lib/pinksale-chains';

const POOL_ABI = [
  'function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)'
];

const ALCHEMY_NETWORK_BY_CHAIN = {
  1: 'eth-mainnet',
  56: 'bnb-mainnet',
  137: 'polygon-mainnet',
  42161: 'arb-mainnet',
  8453: 'base-mainnet',
  43114: 'avax-mainnet'
};

function withTimeout(promise, timeoutMs, message = 'Timed out') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getServerRpcForChain(chainId) {
  const id = Number(chainId);
  const alchemyKey = process.env.ALCHEMY_KEY || process.env.NEXT_ALCHEMY_KEY || '';
  const alchemyNetwork = ALCHEMY_NETWORK_BY_CHAIN[id];
  const alchemyRpc =
    alchemyKey && alchemyNetwork
      ? `https://${alchemyNetwork}.g.alchemy.com/v2/${alchemyKey}`
      : '';

  if (id === 1) {
    return process.env.ETHEREUM_RPC || process.env.RPC_ETH || process.env.ETHEREUM_RPC_URL || alchemyRpc;
  }
  if (id === 56) {
    return process.env.BSC_RPC || process.env.BSC_RPC_URL || alchemyRpc;
  }
  if (id === 137) {
    return process.env.RPC_POLYGON || process.env.POLYGON_RPC_URL || alchemyRpc;
  }
  if (id === 42161) {
    return process.env.RPC_ARBITRUM || process.env.ARBITRUM_RPC_URL || alchemyRpc;
  }
  if (id === 8453) {
    return process.env.RPC_BASE || process.env.BASE_RPC_URL || alchemyRpc;
  }
  if (id === 43114) {
    return process.env.AVALANCHE_RPC_URL || alchemyRpc;
  }

  return '';
}

async function getWorkingProvider(chainId) {
  const candidates = [
    ...new Set([getServerRpcForChain(chainId), ...getEvmRpcCandidates(chainId)].filter(Boolean))
  ];

  for (const rpcUrl of candidates) {
    try {
      const provider = new JsonRpcProvider(rpcUrl, Number(chainId), {
        staticNetwork: true,
        batchMaxCount: 1
      });
      const blockNo = await withTimeout(
        provider.getBlockNumber(),
        7000,
        `RPC probe timeout for chain ${chainId}`
      );
      if (Number.isFinite(Number(blockNo))) {
        return provider;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const chainId = Number(req.query.chainId);
    const poolAddress = String(req.query.poolAddress || '').trim();
    if (!Number.isFinite(chainId) || !poolAddress) {
      return res
        .status(400)
        .json({ ok: false, error: 'chainId and poolAddress are required' });
    }
    if (!isEvmChain(chainId)) {
      return res.status(400).json({ ok: false, error: 'chain is not EVM' });
    }

    const provider = await getWorkingProvider(chainId);
    if (!provider) {
      return res.status(503).json({ ok: false, error: 'No working RPC provider' });
    }

    const contract = new Contract(poolAddress, POOL_ABI, provider);
    const states = await withTimeout(contract.poolStates(), 15000, 'poolStates timed out');
    const stateValue = states?.state ?? states?.[0] ?? null;
    const totalRaisedRaw = states?.totalRaised ?? states?.[2] ?? null;

    if (totalRaisedRaw == null) {
      return res.status(200).json({ ok: true, state: null, totalRaised: null });
    }

    const totalRaised =
      typeof totalRaisedRaw === 'bigint'
        ? totalRaisedRaw.toString()
        : typeof totalRaisedRaw?.toString === 'function'
          ? totalRaisedRaw.toString()
          : String(totalRaisedRaw);

    const state =
      stateValue == null
        ? null
        : Number(typeof stateValue === 'bigint' ? stateValue : stateValue.toString());

    return res.status(200).json({ ok: true, state, totalRaised });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to fetch pool live state'
    });
  }
}

