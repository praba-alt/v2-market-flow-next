import Database from 'better-sqlite3';
import { JsonRpcProvider, Contract } from 'ethers';
import { getChainConfig, isEvmChain, getDefaultEvmRpcUrl } from '../lib/pinksale-chains.js';
import { PINKSALE_ERC20_ABI, PINKSALE_LAUNCHPAD_V2_ABI } from '../lib/abis/pinksale-launchpad-v2-abi.js';

const db = new Database('./data/contract-pools.sqlite', { readonly: true });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms))
  ]);
}

function short(v, n = 220) {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

const chainRows = db.prepare(`
  SELECT p.chain_id, COUNT(*) AS c
  FROM pools p
  JOIN tokens t ON t.token_id = p.token_id
  WHERE p.chain_id IS NOT NULL
    AND p.pool_address IS NOT NULL AND p.pool_address != ''
    AND t.token_address IS NOT NULL AND t.token_address != ''
  GROUP BY p.chain_id
  HAVING COUNT(*) >= 1
  ORDER BY c DESC
`).all();

const evmChains = chainRows.map((r) => Number(r.chain_id)).filter((cid) => isEvmChain(cid));

console.log('EVM chains found in DB:', evmChains.join(', '));
console.log('Running probe: 2 pools per chain (latest by pool_id).');

const summary = [];

for (const chainId of evmChains) {
  const cfg = getChainConfig(chainId);
  const envName = cfg?.rpcEnvVar || '';
  const envUrl = envName ? process.env[envName] : '';
  const rpcUrl = envUrl || getDefaultEvmRpcUrl(chainId);

  const pools = db.prepare(`
    SELECT p.pool_id, p.pool_address, p.chain_id, t.token_address
    FROM pools p
    JOIN tokens t ON t.token_id = p.token_id
    WHERE p.chain_id = ?
      AND p.pool_address IS NOT NULL AND p.pool_address != ''
      AND t.token_address IS NOT NULL AND t.token_address != ''
    ORDER BY p.pool_id DESC
    LIMIT 2
  `).all(chainId);

  const chainResult = {
    chainId,
    chainName: cfg?.name || ('Chain ' + chainId),
    rpcEnvVar: envName || null,
    rpcSource: envUrl ? 'env' : 'default',
    rpcUrl,
    networkOk: false,
    networkError: null,
    pools: []
  };

  console.log('\n=== CHAIN', chainResult.chainName, '(' + chainId + ') ===');
  console.log('RPC source:', chainResult.rpcSource, '| env var:', chainResult.rpcEnvVar || '-', '| url:', rpcUrl || '-');

  if (!rpcUrl) {
    chainResult.networkError = 'No RPC URL configured';
    console.log('Network check: FAIL -', chainResult.networkError);
    summary.push(chainResult);
    continue;
  }

  const provider = new JsonRpcProvider(rpcUrl);

  try {
    const net = await withTimeout(provider.getNetwork(), 12000, 'getNetwork');
    chainResult.networkOk = true;
    chainResult.detectedChainId = Number(net.chainId);
    console.log('Network check: OK | detected chainId =', chainResult.detectedChainId);
  } catch (e) {
    chainResult.networkError = short(e?.message || e);
    console.log('Network check: FAIL -', chainResult.networkError);
    summary.push(chainResult);
    continue;
  }

  for (const row of pools) {
    console.log('\n  Pool sample: pool_id=' + row.pool_id);
    console.log('  poolAddress =', row.pool_address);
    console.log('  tokenAddress=', row.token_address);

    const poolResult = {
      poolId: row.pool_id,
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      token: { ok: false },
      pool: { ok: false }
    };

    const tokenContract = new Contract(row.token_address, PINKSALE_ERC20_ABI, provider);
    const poolContract = new Contract(row.pool_address, PINKSALE_LAUNCHPAD_V2_ABI, provider);

    try {
      const [name, symbol, decimals, totalSupply] = await withTimeout(
        Promise.all([
          tokenContract.name(),
          tokenContract.symbol(),
          tokenContract.decimals(),
          tokenContract.totalSupply()
        ]),
        22000,
        'tokenCalls'
      );
      poolResult.token = {
        ok: true,
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply: totalSupply?.toString?.() ?? String(totalSupply)
      };
      console.log('  token calls: OK |', name, '|', symbol, '| decimals=' + Number(decimals));
    } catch (e) {
      poolResult.token = { ok: false, error: short(e?.message || e) };
      console.log('  token calls: FAIL -', poolResult.token.error);
    }

    try {
      const [poolStates, poolSettings, poolType, softCap, hardCap] = await withTimeout(
        Promise.all([
          poolContract.poolStates(),
          poolContract.poolSettings(),
          poolContract.poolType(),
          poolContract.softCap(),
          poolContract.hardCap()
        ]),
        22000,
        'poolCalls'
      );

      poolResult.pool = {
        ok: true,
        state: Number(poolStates?.state ?? poolStates?.[0] ?? NaN),
        finishTime: (poolStates?.finishTime ?? poolStates?.[1])?.toString?.() ?? null,
        totalRaised: (poolStates?.totalRaised ?? poolStates?.[2])?.toString?.() ?? null,
        startTime: Number(poolSettings?.startTime ?? poolSettings?.[2] ?? NaN),
        endTime: Number(poolSettings?.endTime ?? poolSettings?.[3] ?? NaN),
        poolType: Number(poolType),
        softCap: softCap?.toString?.() ?? null,
        hardCap: hardCap?.toString?.() ?? null
      };
      console.log('  pool calls : OK | state=' + poolResult.pool.state + ' type=' + poolResult.pool.poolType + ' start=' + poolResult.pool.startTime + ' end=' + poolResult.pool.endTime);
    } catch (e) {
      poolResult.pool = { ok: false, error: short(e?.message || e) };
      console.log('  pool calls : FAIL -', poolResult.pool.error);
    }

    chainResult.pools.push(poolResult);
  }

  summary.push(chainResult);
}

const chainStats = summary.map((c) => {
  const tokenOk = c.pools.filter((p) => p.token.ok).length;
  const poolOk = c.pools.filter((p) => p.pool.ok).length;
  return {
    chainId: c.chainId,
    chain: c.chainName,
    rpcSource: c.rpcSource,
    rpcEnvVar: c.rpcEnvVar,
    networkOk: c.networkOk,
    detectedChainId: c.detectedChainId ?? null,
    sampledPools: c.pools.length,
    tokenOk,
    poolOk,
    networkError: c.networkError
  };
});

console.log('\n=== CHAIN SUMMARY JSON ===');
console.log(JSON.stringify(chainStats, null, 2));
