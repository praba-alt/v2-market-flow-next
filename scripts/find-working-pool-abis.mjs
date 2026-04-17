import Database from 'better-sqlite3';
import { Contract, JsonRpcProvider } from 'ethers';
import { getChainConfig, getEvmRpcCandidates, isEvmChain } from '../lib/pinksale-chains.js';
import fs from 'fs';

const DB_PATH = './data/contract-pools.sqlite';
const SAMPLE_PER_CHAIN = Math.max(1, Number(process.env.ABI_SCAN_SAMPLES_PER_CHAIN || 2));
const CALL_TIMEOUT_MS = Math.max(1200, Number(process.env.ABI_SCAN_TIMEOUT_MS || 3500));

const PROFILES = {
  v2_tuple: [
    'function poolSettings() view returns (address token, address currency, uint256 startTime, uint256 endTime, uint256 rate, uint256 listingRate, uint256 softCapTokens, uint256 totalSellingTokens)',
    'function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)'
  ],
  v2_optional: [
    'function poolType() view returns (uint8)',
    'function softCap() view returns (uint256)',
    'function hardCap() view returns (uint256)',
    'function min() view returns (uint256)',
    'function max() view returns (uint256)'
  ],
  legacy_scalar: [
    'function token() view returns (address)',
    'function currency() view returns (address)',
    'function startTime() view returns (uint256)',
    'function endTime() view returns (uint256)',
    'function rate() view returns (uint256)',
    'function listingRate() view returns (uint256)',
    'function state() view returns (uint8)',
    'function finishTime() view returns (uint256)',
    'function totalRaised() view returns (uint256)',
    'function totalCommitted() view returns (uint256)',
    'function totalVolumePurchased() view returns (uint256)',
    'function liquidityUnlockTime() view returns (uint256)',
    'function poolDetails() view returns (string)',
    'function kycDetails() view returns (string)'
  ],
  misc_pool: [
    'function needCalculate() view returns (bool)',
    'function calculationStage() view returns (uint8 stage, uint256 currentIndex, uint256 finishedAllocatingUserCount, uint256 distributableRaised, uint256 excessiveAllocations, uint256 tempDistributableRaised, uint256 tempExcessiveAllocations)',
    'function getContributorCount() view returns (uint256)',
    'function getFeeSettings() view returns (uint128 currency, uint128 token)'
  ]
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms))
  ]);
}

async function safeCall(fn) {
  try {
    await withTimeout(fn(), CALL_TIMEOUT_MS, 'eth_call');
    return true;
  } catch {
    return false;
  }
}

async function pickProvider(chainId) {
  const candidates = getEvmRpcCandidates(chainId);
  for (const rpcUrl of candidates) {
    const provider = new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true, batchMaxCount: 1 });
    const ok = await safeCall(() => provider.getBlockNumber());
    if (ok) return { provider, rpcUrl };
  }
  return { provider: null, rpcUrl: null };
}

function scoreProfile(resultMap, profileName, sampleCount) {
  const methods = PROFILES[profileName];
  let sum = 0;
  for (const sig of methods) {
    const entry = resultMap.get(sig) || { ok: 0 };
    sum += entry.ok;
  }
  return methods.length ? Number((sum / (methods.length * sampleCount)).toFixed(4)) : 0;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const chainRows = db
    .prepare(
      `
      SELECT p.chain_id, COUNT(*) AS count
      FROM pools p
      WHERE p.chain_id IS NOT NULL AND p.pool_address IS NOT NULL AND p.pool_address != ''
      GROUP BY p.chain_id
      ORDER BY count DESC
      `
    )
    .all()
    .map((row) => Number(row.chain_id))
    .filter((chainId) => isEvmChain(chainId));

  const output = [];

  for (const chainId of chainRows) {
    const cfg = getChainConfig(chainId);
    const pools = db
      .prepare(
        `
        SELECT pool_id, pool_address
        FROM pools
        WHERE chain_id = ?
          AND pool_address IS NOT NULL AND pool_address != ''
        ORDER BY pool_id DESC
        LIMIT ?
        `
      )
      .all(chainId, SAMPLE_PER_CHAIN);

    const { provider, rpcUrl } = await pickProvider(chainId);
    const row = {
      chainId,
      chainName: cfg?.name || `Chain ${chainId}`,
      sampledPools: pools.length,
      rpcUrl,
      networkOk: Boolean(provider),
      profileScores: {},
      recommendedProfile: null
    };

    if (!provider || !pools.length) {
      output.push(row);
      continue;
    }

    const allMethods = [...new Set(Object.values(PROFILES).flat())];
    const methodStats = new Map(allMethods.map((sig) => [sig, { ok: 0, fail: 0 }]));

    for (const pool of pools) {
      const calls = allMethods.map(async (sig) => {
        const contract = new Contract(pool.pool_address, [sig], provider);
        const fnName = sig.slice('function '.length).split('(')[0].trim();
        const ok = await safeCall(() => contract[fnName]());
        return { sig, ok };
      });
      const results = await Promise.all(calls);
      for (const { sig, ok } of results) {
        if (ok) methodStats.get(sig).ok += 1;
        else methodStats.get(sig).fail += 1;
      }
    }

    for (const profileName of Object.keys(PROFILES)) {
      row.profileScores[profileName] = scoreProfile(methodStats, profileName, pools.length);
    }

    const ranked = Object.entries(row.profileScores).sort((a, b) => b[1] - a[1]);
    row.recommendedProfile = ranked[0]?.[1] > 0 ? ranked[0][0] : null;
    row.methodSuccess = Object.fromEntries(
      [...methodStats.entries()]
        .map(([sig, st]) => [sig, Number((st.ok / pools.length).toFixed(3))])
        .filter(([, rate]) => rate > 0)
    );

    output.push(row);
  }

  const outPath = './data/working-pool-abi-by-chain.json';
  const payload = {
    generatedAt: new Date().toISOString(),
    samplePerChain: SAMPLE_PER_CHAIN,
    timeoutMs: CALL_TIMEOUT_MS,
    profiles: PROFILES,
    chains: output
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Wrote: ${outPath}`);
  for (const c of output) {
    const p = c.recommendedProfile || 'none';
    console.log(
      `${c.chainName} (${c.chainId}) network=${c.networkOk ? 'ok' : 'fail'} samples=${c.sampledPools} profile=${p} scores=${JSON.stringify(c.profileScores)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
