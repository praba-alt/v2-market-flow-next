import Database from 'better-sqlite3';
import { Contract, JsonRpcProvider } from 'ethers';

import { callNonEvmRpc } from '../lib/non-evm-rpc.js';
import {
  getChainName,
  getEvmRpcCandidates,
  isEvmChain,
  isNonEvmChain
} from '../lib/pinksale-chains.js';

const db = new Database('./data/contract-pools.sqlite', { readonly: true });

const DEFAULT_CHAIN_IDS = [1, 56, 8453, 501424];
const SAMPLE_PER_CHAIN = Math.max(
  1,
  Number(process.env.PINKSALE_PROBE_SAMPLES_PER_CHAIN || 2)
);
const CALL_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.PINKSALE_PROBE_TIMEOUT_MS || 12000)
);

const EVM_PROFILES = {
  legacy_v12_tuple: [
    'function poolSettings() view returns (address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint256 liquidityListingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
    'function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, uint256 totalVestedTokens, int256 lockId, string poolDetails, string kycDetails)',
    'function contributorVestingSettings() view returns (uint256 tgeReleasePct, uint256 cycleReleasePct, uint256 cycle)',
    'function getContributionSettings() view returns (uint256 min, uint256 max)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)',
    'function owner() view returns (address)',
    'function getOwner() view returns (address)',
    'function router() view returns (address)',
    'function version() view returns (uint8)'
  ],
  v2_subscription_tuple: [
    'function poolSettings() view returns (address token, address currency, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 listingRate, uint256 softCapTokens, uint256 totalSellingTokens, uint256 hardCapTokensPerUser, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
    'function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)',
    'function owner() view returns (address)',
    'function factory() view returns (address)',
    'function router() view returns (address)',
    'function version() view returns (uint8)',
    'function getImplementationVersion() view returns (uint8)',
    'function needCalculate() view returns (bool)',
    'function calculationStage() view returns (uint8 stage, uint256 currentIndex, uint256 finishedAllocatingUserCount, uint256 distributableRaised, uint256 excessiveAllocations, uint256 tempDistributableRaised, uint256 tempExcessiveAllocations)',
    'function getContributorCount() view returns (uint256)'
  ],
  manual_list_presale_tuple: [
    'function poolSettings() view returns (address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint128 liquidityPercent, uint128 refundType)',
    'function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, string poolDetails, string kycDetails)',
    'function getContributionSettings() view returns (uint256 min, uint256 max)',
    'function contributorVestingSettings() view returns (uint256 tgeReleasePct, uint256 cycleReleasePct, uint256 cycle)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)',
    'function getOwner() view returns (address)',
    'function owner() view returns (address)',
    'function router() view returns (address)',
    'function factory() view returns (address)',
    'function version() view returns (uint8)',
    'function getContributorCount() view returns (uint256)'
  ],
  overflow_pool_type_tuple: [
    'function poolSettings() view returns (address token, address currency, uint256 startTime, uint256 endTime, uint256 softCap, uint256 hardCap, uint256 totalSellingTokens, uint256 rate, uint256 listingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint8 poolType)',
    'function poolStates() view returns (uint8 state, uint8 calculationState, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails, bytes32 allocationRoot, bytes32 noAllocationRoot)',
    'function getContributionSettings() view returns (uint256 min, uint256 max)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)',
    'function owner() view returns (address)',
    'function router() view returns (address)',
    'function factory() view returns (address)',
    'function version() view returns (uint8)',
    'function needCalculate() view returns (bool)',
    'function calculationStage() view returns (uint8 stage, uint256 currentIndex, uint256 finishedAllocatingUserCount, uint256 distributableRaised, uint256 excessiveAllocations, uint256 tempDistributableRaised, uint256 tempExcessiveAllocations)',
    'function getContributorCount() view returns (uint256)'
  ],
  scalar_fallback: [
    'function token() view returns (address)',
    'function currency() view returns (address)',
    'function startTime() view returns (uint256)',
    'function endTime() view returns (uint256)',
    'function publicSaleStartTime() view returns (uint256)',
    'function claimTime() view returns (uint256)',
    'function rate() view returns (uint256)',
    'function listingRate() view returns (uint256)',
    'function state() view returns (uint8)',
    'function finishTime() view returns (uint256)',
    'function totalRaised() view returns (uint256)',
    'function totalCommitted() view returns (uint256)',
    'function totalVolumePurchased() view returns (uint256)',
    'function totalSellingTokens() view returns (uint256)',
    'function softCap() view returns (uint256)',
    'function hardCap() view returns (uint256)',
    'function liquidityUnlockTime() view returns (uint256)',
    'function liquidityPercentage() view returns (uint256)',
    'function liquidityPercent() view returns (uint256)',
    'function buybackPercentage() view returns (uint256)',
    'function poolDetails() view returns (string)',
    'function kycDetails() view returns (string)',
    'function initialMarketCap() view returns (uint256)',
    'function poolType() view returns (uint8)',
    'function getContributorCount() view returns (uint256)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)',
    'function version() view returns (uint8)',
    'function getImplementationVersion() view returns (uint8)',
    'function owner() view returns (address)',
    'function getOwner() view returns (address)',
    'function router() view returns (address)',
    'function factory() view returns (address)',
    'function needCalculate() view returns (bool)',
    'function calculationStage() view returns (uint8 stage, uint256 currentIndex, uint256 finishedAllocatingUserCount, uint256 distributableRaised, uint256 excessiveAllocations, uint256 tempDistributableRaised, uint256 tempExcessiveAllocations)'
  ]
};

const NON_EVM_METHODS = {
  501424: [
    {
      method: 'getAccountInfo',
      buildParams: ({ poolAddress }) => [poolAddress, { encoding: 'base64' }]
    },
    {
      method: 'getTokenSupply',
      buildParams: ({ tokenAddress }) => [tokenAddress]
    },
    {
      method: 'getBalance',
      buildParams: ({ poolAddress }) => [poolAddress]
    },
    {
      method: 'getTokenAccountsByOwner',
      buildParams: ({ poolAddress, tokenAddress }) => [
        poolAddress,
        { mint: tokenAddress },
        { encoding: 'jsonParsed' }
      ]
    }
  ]
};

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)
    )
  ]);
}

function shortValue(value, max = 180) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeProbeValue(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return shortValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return shortValue(
      JSON.stringify(
        value.map((item) =>
          item != null && typeof item.toString === 'function' && typeof item !== 'string'
            ? item.toString()
            : item
        )
      )
    );
  }

  try {
    const entries = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => Number.isNaN(Number(key)))
        .slice(0, 16)
        .map(([key, item]) => [
          key,
          item != null && typeof item.toString === 'function' && typeof item !== 'string'
            ? item.toString()
            : item
        ])
    );
    return shortValue(JSON.stringify(entries));
  } catch {
    return shortValue(String(value));
  }
}

async function safeEvmCall(contract, methodName) {
  try {
    const value = await withTimeout(contract[methodName](), methodName);
    return { ok: true, value: normalizeProbeValue(value) };
  } catch (error) {
    return { ok: false, error: shortValue(error?.message || error) };
  }
}

async function safeNonEvmCall(chainId, method, params) {
  try {
    const response = await withTimeout(
      callNonEvmRpc(chainId, method, params, CALL_TIMEOUT_MS),
      method
    );
    if (response?.error) {
      return {
        ok: false,
        error: shortValue(response.error?.message || JSON.stringify(response.error))
      };
    }
    return { ok: true, value: normalizeProbeValue(response?.result ?? response) };
  } catch (error) {
    return { ok: false, error: shortValue(error?.message || error) };
  }
}

function getSelectedChainIds() {
  const raw = String(process.env.PINKSALE_PROBE_CHAINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return raw.length ? raw : DEFAULT_CHAIN_IDS;
}

function getSampleRowsForChain(chainId) {
  return db
    .prepare(
      `
        SELECT p.pool_id, p.pool_address, t.token_address
        FROM pools p
        JOIN tokens t ON t.token_id = p.token_id
        WHERE p.chain_id = ?
          AND p.pool_address IS NOT NULL AND p.pool_address != ''
          AND t.token_address IS NOT NULL AND t.token_address != ''
        ORDER BY p.source_index ASC, p.pool_id ASC
        LIMIT ?
      `
    )
    .all(chainId, SAMPLE_PER_CHAIN);
}

async function probeEvmChain(chainId, rows) {
  const rpcUrl = getEvmRpcCandidates(chainId)[0] || null;
  if (!rpcUrl) {
    return {
      chainId,
      chainName: getChainName(chainId),
      family: 'evm',
      rpcUrl: null,
      networkOk: false,
      error: 'No RPC URL configured',
      samples: []
    };
  }

  const provider = new JsonRpcProvider(rpcUrl, Number(chainId), {
    staticNetwork: true,
    batchMaxCount: 1
  });

  try {
    await withTimeout(provider.getBlockNumber(), 'getBlockNumber');
  } catch (error) {
    return {
      chainId,
      chainName: getChainName(chainId),
      family: 'evm',
      rpcUrl,
      networkOk: false,
      error: shortValue(error?.message || error),
      samples: []
    };
  }

  const samples = [];
  for (const row of rows) {
    const profiles = {};
    for (const [profileName, abi] of Object.entries(EVM_PROFILES)) {
      const contract = new Contract(row.pool_address, abi, provider);
      const methods = [];

      for (const signature of abi) {
        const methodName = signature.slice('function '.length).split('(')[0];
        const result = await safeEvmCall(contract, methodName);
        methods.push({
          method: methodName,
          ok: result.ok,
          value: result.ok ? result.value : null,
          error: result.ok ? null : result.error
        });
      }

      profiles[profileName] = methods;
    }

    samples.push({
      poolId: row.pool_id,
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      profiles
    });
  }

  return {
    chainId,
    chainName: getChainName(chainId),
    family: 'evm',
    rpcUrl,
    networkOk: true,
    samples
  };
}

async function probeNonEvmChain(chainId, rows) {
  const methods = NON_EVM_METHODS[chainId] || [];
  const samples = [];

  for (const row of rows) {
    const results = [];
    for (const config of methods) {
      const params = config.buildParams({
        poolAddress: row.pool_address,
        tokenAddress: row.token_address
      });
      const result = await safeNonEvmCall(chainId, config.method, params);
      results.push({
        method: config.method,
        ok: result.ok,
        value: result.ok ? result.value : null,
        error: result.ok ? null : result.error
      });
    }

    samples.push({
      poolId: row.pool_id,
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      methods: results
    });
  }

  return {
    chainId,
    chainName: getChainName(chainId),
    family: 'non-evm',
    networkOk: true,
    samples
  };
}

function summarizeChain(result) {
  console.log(`\n=== ${result.chainName} (${result.chainId}) [${result.family}] ===`);
  if (!result.networkOk) {
    console.log(`network: FAIL ${result.error || '-'}`);
    return;
  }
  if (result.rpcUrl) {
    console.log(`rpc: ${result.rpcUrl}`);
  }

  for (const sample of result.samples) {
    console.log(`\nPOOL ${sample.poolAddress}`);
    if (result.family === 'evm') {
      for (const [profileName, methods] of Object.entries(sample.profiles)) {
        const okCount = methods.filter((method) => method.ok).length;
        console.log(` profile=${profileName} ok=${okCount}/${methods.length}`);
        for (const method of methods) {
          const suffix = method.ok ? method.value : method.error;
          console.log(`  ${method.method.padEnd(28)} ${method.ok ? 'OK' : 'FAIL'} ${suffix}`);
        }
      }
    } else {
      for (const method of sample.methods) {
        const suffix = method.ok ? method.value : method.error;
        console.log(`  ${method.method.padEnd(28)} ${method.ok ? 'OK' : 'FAIL'} ${suffix}`);
      }
    }
  }
}

async function main() {
  const chainIds = getSelectedChainIds();
  const results = [];

  for (const chainId of chainIds) {
    const rows = getSampleRowsForChain(chainId);
    if (isEvmChain(chainId)) {
      results.push(await probeEvmChain(chainId, rows));
      continue;
    }
    if (isNonEvmChain(chainId)) {
      results.push(await probeNonEvmChain(chainId, rows));
      continue;
    }
    results.push({
      chainId,
      chainName: getChainName(chainId),
      family: 'unknown',
      networkOk: false,
      error: 'Unsupported chain family',
      samples: []
    });
  }

  for (const result of results) {
    summarizeChain(result);
  }

  console.log('\n=== JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
