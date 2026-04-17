import { AbiCoder, Contract, Interface, JsonRpcProvider } from 'ethers';
import Database from 'better-sqlite3';

import {
  getChainName,
  getEvmRpcCandidates,
  isEvmChain,
  isNonEvmChain
} from '../lib/pinksale-chains.js';
import { callNonEvmRpc } from '../lib/non-evm-rpc.js';
import {
  CHAIN_POOL_ABI_RECOMMENDATION,
  PINKSALE_POOL_HELPER_ABI,
  PINKSALE_POOL_PROFILES
} from '../lib/abis/pinksale-launchpad-v2-abi.js';

const db = new Database('./data/contract-pools.sqlite', { readonly: true });
const abiCoder = AbiCoder.defaultAbiCoder();
const rawIface = new Interface(['function poolSettings()', 'function poolStates()']);
const callTimeoutMs = Math.max(3000, Number(process.env.TARGET_CALL_TIMEOUT_MS || 8000));
const sampleLimit = Math.max(1, Number(process.env.TARGET_SAMPLE_LIMIT || 2));
const helperMethods = [
  'getContributionSettings',
  'contributorVestingSettings',
  'getFeeSettings',
  'owner',
  'getOwner',
  'router',
  'factory',
  'version',
  'getImplementationVersion',
  'getContributorCount'
];

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), callTimeoutMs)
    )
  ]);
}

function short(value, max = 140) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function getChainIds() {
  const requested = String(process.env.TARGET_CHAIN_IDS || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  if (requested.length) return requested;

  return db
    .prepare('SELECT DISTINCT chain_id FROM pools ORDER BY chain_id ASC')
    .all()
    .map((row) => Number(row.chain_id));
}

function getRows(chainId) {
  return db
    .prepare(
      `
        SELECT p.pool_id, p.pool_address, t.token_address
        FROM pools p
        JOIN tokens t ON t.token_id = p.token_id
        WHERE p.chain_id = ?
        ORDER BY p.source_index ASC, p.pool_id ASC
        LIMIT ?
      `
    )
    .all(chainId, sampleLimit);
}

async function testEvm(chainId, rows) {
  const rpcUrl = getEvmRpcCandidates(chainId)[0] || null;
  if (!rpcUrl) {
    return {
      chainId,
      chainName: getChainName(chainId),
      family: 'evm',
      rpcUrl: null,
      status: 'no_rpc',
      samples: []
    };
  }

  const provider = new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
    batchMaxCount: 1
  });

  try {
    await withTimeout(provider.getBlockNumber(), 'probe');
  } catch (error) {
    return {
      chainId,
      chainName: getChainName(chainId),
      family: 'evm',
      rpcUrl,
      status: 'rpc_fail',
      error: short(error.message),
      samples: []
    };
  }

  const profileName = CHAIN_POOL_ABI_RECOMMENDATION[chainId] || 'legacy_presale_v12';
  const profile = PINKSALE_POOL_PROFILES[profileName] || null;
  const samples = [];

  for (const row of rows) {
    const sample = {
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      profileName,
      settingsOk: false,
      statesOk: false,
      helperOk: 0,
      helperTotal: helperMethods.length,
      exampleFields: {},
      errors: []
    };

    if (profile) {
      try {
        const settingsRaw = await withTimeout(
          provider.call({
            to: row.pool_address,
            data: rawIface.encodeFunctionData('poolSettings')
          }),
          'poolSettings'
        );
        const decoded = abiCoder.decode([profile.settingsSignature], settingsRaw)[0];
        sample.settingsOk = true;
        sample.exampleFields.currency = short(decoded[1]);
        sample.exampleFields.start = short(
          decoded[
            profileName === 'subscription_v2'
              ? 3
              : profileName === 'overflow_pool_type'
                ? 2
                : 4
          ]
        );
      } catch (error) {
        sample.errors.push(`settings:${short(error.message)}`);
      }

      try {
        const statesRaw = await withTimeout(
          provider.call({
            to: row.pool_address,
            data: rawIface.encodeFunctionData('poolStates')
          }),
          'poolStates'
        );
        const decoded = abiCoder.decode([profile.statesSignature], statesRaw)[0];
        sample.statesOk = true;
        sample.exampleFields.state = short(decoded[0]);
        sample.exampleFields.raised = short(decoded[2]);
      } catch (error) {
        sample.errors.push(`states:${short(error.message)}`);
      }
    } else {
      sample.errors.push('profile:missing');
    }

    const helperContract = new Contract(row.pool_address, PINKSALE_POOL_HELPER_ABI, provider);
    for (const method of helperMethods) {
      try {
        await withTimeout(helperContract[method](), method);
        sample.helperOk += 1;
      } catch {
        // Count failures implicitly.
      }
    }

    samples.push(sample);
  }

  return {
    chainId,
    chainName: getChainName(chainId),
    family: 'evm',
    rpcUrl,
    status: 'ok',
    samples
  };
}

async function testNonEvm(chainId, rows) {
  const samples = [];

  for (const row of rows) {
    const sample = {
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      methods: []
    };

    if (chainId === 501424) {
      for (const [method, params] of [
        ['getAccountInfo', [row.pool_address, { encoding: 'base64' }]],
        ['getTokenSupply', [row.token_address]],
        ['getBalance', [row.pool_address]],
        [
          'getTokenAccountsByOwner',
          [row.pool_address, { mint: row.token_address }, { encoding: 'jsonParsed' }]
        ]
      ]) {
        try {
          const res = await withTimeout(
            callNonEvmRpc(chainId, method, params, callTimeoutMs),
            method
          );
          sample.methods.push({
            method,
            ok: !res?.error,
            value: short(JSON.stringify(res?.result ?? res))
          });
        } catch (error) {
          sample.methods.push({ method, ok: false, error: short(error.message) });
        }
      }
    } else if (chainId === 50104) {
      for (const [method, params] of [
        ['suix_getCoinMetadata', [row.token_address]],
        ['suix_getTotalSupply', [row.token_address]]
      ]) {
        try {
          const res = await withTimeout(
            callNonEvmRpc(chainId, method, params, callTimeoutMs),
            method
          );
          sample.methods.push({
            method,
            ok: !res?.error,
            value: short(JSON.stringify(res?.result ?? res))
          });
        } catch (error) {
          sample.methods.push({ method, ok: false, error: short(error.message) });
        }
      }
    } else if (chainId === -239) {
      for (const [label, address] of [
        ['pool', row.pool_address],
        ['token', row.token_address]
      ]) {
        try {
          const res = await withTimeout(
            callNonEvmRpc(chainId, 'getAddressInformation', [address], callTimeoutMs),
            'getAddressInformation'
          );
          sample.methods.push({
            method: `getAddressInformation:${label}`,
            ok: !res?.error,
            value: short(JSON.stringify(res?.result ?? res))
          });
        } catch (error) {
          sample.methods.push({
            method: `getAddressInformation:${label}`,
            ok: false,
            error: short(error.message)
          });
        }
      }
    }

    samples.push(sample);
  }

  return {
    chainId,
    chainName: getChainName(chainId),
    family: 'non-evm',
    status: 'ok',
    samples
  };
}

const startedAt = new Date().toISOString();
const results = [];
for (const chainId of getChainIds()) {
  const rows = getRows(chainId);
  if (isEvmChain(chainId)) {
    results.push(await testEvm(chainId, rows));
  } else if (isNonEvmChain(chainId)) {
    results.push(await testNonEvm(chainId, rows));
  } else {
    results.push({
      chainId,
      chainName: getChainName(chainId),
      family: 'unknown',
      status: 'unsupported',
      samples: []
    });
  }
}

console.log(
  JSON.stringify(
    {
      startedAt,
      finishedAt: new Date().toISOString(),
      callTimeoutMs,
      sampleLimit,
      results
    },
    null,
    2
  )
);
