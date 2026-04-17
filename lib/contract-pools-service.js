import { AbiCoder, Contract, Interface, JsonRpcProvider } from 'ethers';
import fs from 'fs';
import path from 'path';

import { getEvmRpcCandidates, isEvmChain } from './pinksale-chains';
import {
  getCreatedTimeDelayMs,
  getEvmEnrichDelayMs,
  isChainEnabledForEnrich,
  isTemporarilyUnavailableChain,
  TEMP_UNAVAILABLE_CHAIN_IDS
} from './chain-availability';
import { callNonEvmRpc, resolveNonEvmChain } from './non-evm-rpc';
import {
  CHAIN_POOL_ABI_RECOMMENDATION,
  PINKSALE_ERC20_ABI,
  PINKSALE_LAUNCHPAD_LEGACY_SCALAR_ABI,
  PINKSALE_POOL_HELPER_ABI,
  PINKSALE_POOL_PROFILES
} from './abis/pinksale-launchpad-v2-abi';
import {
  dbMeta,
  getDb,
  getPoolByChainAndAddress,
  listPoolsMissingContractCreatedAt,
  listPoolsForEnrichment,
  markPoolDynamicChecked,
  markPoolPostEndChecked,
  poolExists,
  updatePoolSourceIndex,
  updatePoolContractCreatedAt,
  updatePoolEnrichment,
  updateTokenEnrichment,
  upsertPool,
  upsertToken
} from './contract-pools-db';

const MARKET_FLOW_API = 'https://api.pinksale.finance/api/v1/market-flow/list';

const EXCLUDED_CHAIN_IDS = [97, 501423, 3254773, -3];
const CHAIN_SCAN_CONFIG = {
  1: { baseUrl: 'https://api.etherscan.io/api', apiKeyEnv: 'ETHERSCAN_API_KEY' },
  56: { baseUrl: 'https://api.bscscan.com/api', apiKeyEnv: 'BSCSCAN_API_KEY' },
  137: { baseUrl: 'https://api.polygonscan.com/api', apiKeyEnv: 'POLYGONSCAN_API_KEY' },
  250: { baseUrl: 'https://api.ftmscan.com/api', apiKeyEnv: 'FTMSCAN_API_KEY' },
  42161: { baseUrl: 'https://api.arbiscan.io/api', apiKeyEnv: 'ARBISCAN_API_KEY' },
  8453: { baseUrl: 'https://api.basescan.org/api', apiKeyEnv: 'BASESCAN_API_KEY' },
  43114: { baseUrl: 'https://api.snowtrace.io/api', apiKeyEnv: 'SNOWTRACE_API_KEY' }
};

const EVM_ENRICH_CALL_DELAY_MS = Math.max(
  0,
  Number(process.env.EVM_ENRICH_CALL_DELAY_MS || 150)
);
const CREATED_TIME_CALL_DELAY_MS = Math.max(
  0,
  Number(process.env.CREATED_TIME_CALL_DELAY_MS || 200)
);
const ENRICH_PROGRESS_EVERY = Math.max(
  1,
  Number(process.env.ENRICH_PROGRESS_EVERY || 100)
);
const RPC_PROBE_TIMEOUT_MS = Math.max(2000, Number(process.env.RPC_PROBE_TIMEOUT_MS || 7000));
const SAFE_CALL_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.RPC_CALL_TIMEOUT_MS || 15000)
);
const RPC_DEBUG_LOG = String(process.env.RPC_DEBUG_LOG || '').toLowerCase() === 'true';
const RPC_DEBUG_LOG_SUCCESS =
  String(process.env.RPC_DEBUG_LOG_SUCCESS || '').toLowerCase() === 'true';
const ABI_CODER = AbiCoder.defaultAbiCoder();
const PINKSALE_POOL_RAW_INTERFACE = new Interface([
  'function poolSettings()',
  'function poolStates()'
]);

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUnixTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ts = Math.floor(n);
  if (ts < 946684800 || ts > 4102444800) return null; // 2000-01-01 to 2100-01-01
  return ts;
}

function stringifyIfObject(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function waitForChainRateLimit(chainId, delayMs, chainNextAllowedAt) {
  if (!delayMs) return;
  const key = String(chainId);
  const now = Date.now();
  const nextAllowed = Number(chainNextAllowedAt.get(key) || 0);
  if (nextAllowed > now) {
    await new Promise((resolve) => setTimeout(resolve, nextAllowed - now));
  }
  chainNextAllowedAt.set(key, Date.now() + delayMs);
}

function buildMarketFlowUrl(page = 1, limit = 200) {
  const url = new URL(MARKET_FLOW_API);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));

  for (const id of EXCLUDED_CHAIN_IDS) {
    url.searchParams.append('excludeChainIds[]', String(id));
  }

  return url;
}

async function fetchMarketFlowPage(page = 1, limit = 200) {
  const url = buildMarketFlowUrl(page, limit);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  const trimmed = text.trim();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    trimmed.startsWith('<!DOCTYPE html') ||
    trimmed.startsWith('<html');

  if (!res.ok || looksLikeHtml) {
    const cloudflareHint = looksLikeHtml
      ? ' (likely Cloudflare challenge HTML instead of JSON)'
      : '';
    throw new Error(
      `PinkSale API failed (${res.status})${cloudflareHint}: ${trimmed.slice(0, 300)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `PinkSale API returned non-JSON payload (${res.status}): ${trimmed.slice(0, 300)}`
    );
  }
}

async function fetchMarketFlowPageHeadless(page = 1, limit = 200) {
  const { default: puppeteer } = await import('puppeteer');
  const url = buildMarketFlowUrl(page, limit).toString();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const pageObj = await browser.newPage();
    await pageObj.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    await pageObj.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 120000
    });

    const bodyText = await pageObj.evaluate(
      () => (document.body && document.body.innerText) || ''
    );
    const trimmed = String(bodyText || '').trim();

    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      throw new Error(`Headless fetch did not return JSON payload: ${trimmed.slice(0, 300)}`);
    }

    return JSON.parse(trimmed);
  } finally {
    await browser.close();
  }
}

function ingestDocs(docs, { skipExisting = true, startSourceIndex = 0 } = {}) {
  let scannedDocs = 0;
  let upsertedPools = 0;
  let upsertedTokens = 0;
  let skippedExisting = 0;
  let sourceIndex = Number(startSourceIndex) || 0;

  for (const doc of docs) {
    scannedDocs += 1;

    const chainId = toNumber(doc?.chainId);
    const poolAddressRaw = doc?.pool?.address;
    const tokenAddressRaw = doc?.token?.address;

    if (!Number.isFinite(chainId) || !poolAddressRaw || !tokenAddressRaw) {
      continue;
    }

    if (skipExisting && poolExists({ chainId, poolAddress: poolAddressRaw })) {
      updatePoolSourceIndex({
        chainId,
        poolAddress: poolAddressRaw,
        sourceIndex
      });
      skippedExisting += 1;
      sourceIndex += 1;
      continue;
    }

    // Discovery only from PinkSale: chain + pool + token addresses.
    const tokenRow = upsertToken({
      chainId,
      tokenAddressRaw
    });
    if (!tokenRow?.token_id) continue;
    upsertedTokens += 1;

    const poolRow = upsertPool({
      chainId,
      poolAddressRaw,
      tokenId: tokenRow.token_id,
      sourceIndex
    });

    if (poolRow?.pool_id) {
      upsertedPools += 1;
    }
    sourceIndex += 1;
  }

  return {
    scannedDocs,
    upsertedPools,
    upsertedTokens,
    skippedExisting,
    nextSourceIndex: sourceIndex
  };
}

function loadSnapshotDocs(snapshotPath) {
  const resolvedPath = snapshotPath
    ? path.resolve(snapshotPath)
    : path.join(process.cwd(), 'public', 'market-flow-snapshot.json');

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const json = JSON.parse(raw);
  const docs = Array.isArray(json?.docs) ? json.docs : [];

  return { resolvedPath, docs };
}

export async function syncContractsFromPinkSale({
  maxPages = 5,
  pageSize = 200,
  source = 'api',
  snapshotPath = '',
  skipExisting = true
}) {
  const maxPagesRaw = String(maxPages ?? '').trim().toLowerCase();
  const fetchAllPages =
    maxPagesRaw === 'all' ||
    maxPagesRaw === '*' ||
    maxPagesRaw === '0';
  const pagesToFetch = fetchAllPages
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Number(maxPages) || 1);
  const limit = Math.min(3000, Math.max(1, Number(pageSize) || 3000));

  if (source === 'snapshot') {
    const { resolvedPath, docs } = loadSnapshotDocs(snapshotPath);
    const sliced = fetchAllPages ? docs : docs.slice(0, pagesToFetch * limit);
    const { scannedDocs, upsertedPools, upsertedTokens, skippedExisting } = ingestDocs(sliced, {
      skipExisting,
      startSourceIndex: 0
    });

    return {
      db: dbMeta(),
      source: 'snapshot',
      snapshotPath: resolvedPath,
      fetchedPages: 1,
      scannedDocs,
      skippedExisting,
      upsertedTokens,
      upsertedPools
    };
  }

  if (source === 'headless') {
    let currentPage = 1;
    let fetchedPages = 0;
    let upsertedPools = 0;
    let upsertedTokens = 0;
    let scannedDocs = 0;
    let skippedExisting = 0;
    let nextSourceIndex = 0;

    while (fetchedPages < pagesToFetch) {
      const pageJson = await fetchMarketFlowPageHeadless(currentPage, limit);
      const docs = Array.isArray(pageJson?.docs) ? pageJson.docs : [];

      if (!docs.length) break;

      const ingested = ingestDocs(docs, {
        skipExisting,
        startSourceIndex: nextSourceIndex
      });
      scannedDocs += ingested.scannedDocs;
      upsertedPools += ingested.upsertedPools;
      upsertedTokens += ingested.upsertedTokens;
      skippedExisting += ingested.skippedExisting;
      nextSourceIndex = ingested.nextSourceIndex;
      fetchedPages += 1;

      if (!pageJson?.hasNextPage || !pageJson?.nextPage) {
        break;
      }
      currentPage = Number(pageJson.nextPage) || currentPage + 1;
    }

    return {
      db: dbMeta(),
      source: 'headless',
      fetchedPages,
      scannedDocs,
      skippedExisting,
      upsertedTokens,
      upsertedPools
    };
  }

  let currentPage = 1;
  let fetchedPages = 0;
  let upsertedPools = 0;
  let upsertedTokens = 0;
  let scannedDocs = 0;
  let skippedExisting = 0;
  let nextSourceIndex = 0;

  while (fetchedPages < pagesToFetch) {
    const pageJson = await fetchMarketFlowPage(currentPage, limit);
    const docs = Array.isArray(pageJson?.docs) ? pageJson.docs : [];

    if (!docs.length) break;

    const ingested = ingestDocs(docs, {
      skipExisting,
      startSourceIndex: nextSourceIndex
    });
    scannedDocs += ingested.scannedDocs;
    upsertedPools += ingested.upsertedPools;
    upsertedTokens += ingested.upsertedTokens;
    skippedExisting += ingested.skippedExisting;
    nextSourceIndex = ingested.nextSourceIndex;

    fetchedPages += 1;

    if (!pageJson?.hasNextPage || !pageJson?.nextPage) {
      break;
    }
    currentPage = Number(pageJson.nextPage) || currentPage + 1;
  }

  return {
    db: dbMeta(),
    source: 'api',
    fetchedPages,
    scannedDocs,
    skippedExisting,
    upsertedTokens,
    upsertedPools
  };
}

async function getProviderForChain(chainId, providerCache) {
  const key = String(chainId);
  const cached = providerCache.get(key);
  if (cached !== undefined) return cached;

  const fortunaCompatibleRpc = getFortunaCompatibleEvmRpc(chainId);
  const candidates = [
    ...new Set([...getEvmRpcCandidates(chainId), fortunaCompatibleRpc].filter(Boolean))
  ];

  if (!candidates.length) {
    providerCache.set(key, null);
    return null;
  }

  for (const rpcUrl of candidates) {
    const provider = new JsonRpcProvider(rpcUrl, Number(chainId), {
      staticNetwork: true,
      batchMaxCount: 1
    });
    const probe = await safeCall(
      () =>
        withTimeout(
          provider.getBlockNumber(),
          RPC_PROBE_TIMEOUT_MS,
          `RPC probe timeout for chain ${chainId}`
        ),
      null,
      { stage: 'provider.probe', chainId, rpcUrl }
    );
    if (Number.isFinite(Number(probe))) {
      if (RPC_DEBUG_LOG_SUCCESS) {
        logRpc('ok', { stage: 'provider.select', chainId, rpcUrl });
      }
      providerCache.set(key, provider);
      return provider;
    }
  }

  providerCache.set(key, null);
  return null;
}

function getFortunaCompatibleEvmRpc(chainId) {
  const id = Number(chainId);

  if (id === 1) {
    return process.env.ETHEREUM_RPC || process.env.RPC_ETH || process.env.ETHEREUM_RPC_URL || '';
  }
  if (id === 56) {
    return process.env.BSC_RPC || process.env.BSC_RPC_URL || '';
  }
  if (id === 137) {
    return process.env.RPC_POLYGON || process.env.POLYGON_RPC_URL || '';
  }
  if (id === 42161) {
    return process.env.RPC_ARBITRUM || process.env.ARBITRUM_RPC_URL || '';
  }
  if (id === 8453) {
    return process.env.RPC_BASE || process.env.BASE_RPC_URL || '';
  }
  if (id === 43114) {
    return process.env.AVALANCHE_RPC_URL || '';
  }

  return '';
}

function summarizeRpcValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 80)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const text = value.toString();
    if (typeof text === 'string' && text !== '[object Object]') {
      return text.length > 80 ? `${text.slice(0, 80)}...` : text;
    }
  } catch {
    // ignore
  }
  return Array.isArray(value) ? `array(${value.length})` : typeof value;
}

function logRpc(level, payload) {
  if (!RPC_DEBUG_LOG) return;
  const prefix = level === 'error' ? '[rpc:error]' : '[rpc:ok]';
  try {
    console.log(`${prefix} ${JSON.stringify(payload)}`);
  } catch {
    console.log(prefix, payload);
  }
}

async function safeCall(fn, fallback = null, meta = null) {
  const startedAtMs = Date.now();
  try {
    const result = await withTimeout(fn(), SAFE_CALL_TIMEOUT_MS, 'RPC call timed out');
    if (RPC_DEBUG_LOG_SUCCESS && meta) {
      logRpc('ok', {
        ...meta,
        durationMs: Date.now() - startedAtMs,
        result: summarizeRpcValue(result)
      });
    }
    return result;
  } catch (error) {
    if (meta) {
      logRpc('error', {
        ...meta,
        durationMs: Date.now() - startedAtMs,
        error: String(error?.message || error)
      });
    }
    return fallback;
  }
}

function normalizePoolAddress(address) {
  return String(address || '').trim().toLowerCase();
}

function toStringValue(value) {
  if (value == null) return null;
  try {
    return value.toString();
  } catch {
    return null;
  }
}

function toAddressValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === '0x0000000000000000000000000000000000000000') return null;
  return normalized;
}

function getTupleNamedOrIndexed(tupleValue, name, index) {
  if (tupleValue == null) return null;
  try {
    const named = tupleValue?.[name];
    if (named != null) return named;
  } catch {
    // ignore deferred decoding errors on named access
  }
  try {
    return tupleValue?.[index] ?? null;
  } catch {
    return null;
  }
}

function getPoolAbiOrder(chainId) {
  const recommended = CHAIN_POOL_ABI_RECOMMENDATION[Number(chainId)];
  return [
    recommended,
    'legacy_presale_v12',
    'subscription_v2',
    'manual_list_presale',
    'overflow_pool_type',
    'legacy_scalar'
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function getPoolDataScore(data) {
  const keys = [
    'sourceState',
    'currencyAddress',
    'presaleRate',
    'listingRate',
    'softCap',
    'hardCap',
    'totalSellingTokens',
    'startTime',
    'endTime',
    'totalRaised',
    'finishTime',
    'liquidityUnlockTime'
  ];
  return keys.reduce((score, key) => {
    const value = data?.[key];
    if (value == null) return score;
    if (typeof value === 'string' && !value.trim()) return score;
    return score + 1;
  }, 0);
}

async function enrichCurrencyMetadata(currencyAddress, provider) {
  const currencyContract = new Contract(currencyAddress, PINKSALE_ERC20_ABI, provider);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safeCall(() => currencyContract.name(), null, {
      stage: 'currency',
      method: 'name',
      currencyAddress
    }),
    safeCall(() => currencyContract.symbol(), null, {
      stage: 'currency',
      method: 'symbol',
      currencyAddress
    }),
    safeCall(() => currencyContract.decimals(), null, {
      stage: 'currency',
      method: 'decimals',
      currencyAddress
    }),
    safeCall(() => currencyContract.totalSupply(), null, {
      stage: 'currency',
      method: 'totalSupply',
      currencyAddress
    })
  ]);
  return {
    currencyName: typeof name === 'string' ? name : null,
    currencySymbol: typeof symbol === 'string' ? symbol : null,
    currencyDecimals: decimals != null ? Number(decimals) : null,
    currencyTotalSupply: totalSupply != null ? totalSupply.toString() : null
  };
}

function sourceStateFromPoolValue(value) {
  const state = Number(value);
  return Number.isFinite(state) ? state : null;
}

function splitRawWords(rawHex) {
  if (typeof rawHex !== 'string' || !rawHex.startsWith('0x')) return [];
  const body = rawHex.slice(2);
  if (!body || body.length % 64 !== 0) return [];
  const words = [];
  for (let index = 0; index < body.length; index += 64) {
    words.push(body.slice(index, index + 64));
  }
  return words;
}

function isAddressWord(word, { allowZero = false } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(word || '')) return false;
  if (!/^0{24}[0-9a-f]{40}$/i.test(word)) return false;
  if (allowZero) return true;
  return !/^0{64}$/i.test(word);
}

function wordToBigInt(word) {
  if (!/^[0-9a-f]{64}$/i.test(word || '')) return null;
  try {
    return BigInt(`0x${word}`);
  } catch {
    return null;
  }
}

function isTimestampWord(word) {
  const value = wordToBigInt(word);
  if (value == null) return false;
  return value >= 946684800n && value <= 4102444800n;
}

function callPoolRawView(provider, row, method) {
  const encoded = PINKSALE_POOL_RAW_INTERFACE.encodeFunctionData(method);
  return provider.call({
    to: row.pool_address,
    data: encoded
  });
}

function detectPinkSaleProfileFromSettings(rawSettingsHex, chainId) {
  const words = splitRawWords(rawSettingsHex);
  const matches = (profile) => {
    switch (profile) {
      case 'legacy_presale_v12':
        return (
          words.length === 13 &&
          isAddressWord(words[2]) &&
          isAddressWord(words[3]) &&
          isTimestampWord(words[4]) &&
          isTimestampWord(words[5])
        );
      case 'subscription_v2':
        return (
          words.length === 13 &&
          isAddressWord(words[2]) &&
          isTimestampWord(words[3]) &&
          isTimestampWord(words[4])
        );
      case 'manual_list_presale':
        return (
          words.length === 11 &&
          isAddressWord(words[2]) &&
          isAddressWord(words[3]) &&
          isTimestampWord(words[4]) &&
          isTimestampWord(words[5])
        );
      case 'overflow_pool_type':
        return (
          words.length === 13 &&
          isTimestampWord(words[2]) &&
          isTimestampWord(words[3])
        );
      default:
        return false;
    }
  };

  const ordered = getPoolAbiOrder(chainId).filter((profile) => profile !== 'legacy_scalar');
  return ordered.find((profile) => matches(profile)) || null;
}

function decodeTupleValue(signature, rawHex) {
  try {
    return ABI_CODER.decode([signature], rawHex)?.[0] ?? null;
  } catch {
    return null;
  }
}

function compactMetadata(metadata) {
  const entries = Object.entries(metadata || {}).filter(([, value]) => {
    if (value == null) return false;
    if (typeof value === 'string' && !value.trim()) return false;
    return true;
  });
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
}

async function readPinkSaleHelperData(row, provider, profileName) {
  const helperContract = new Contract(row.pool_address, PINKSALE_POOL_HELPER_ABI, provider);
  const rpcMeta = (method) => ({
    stage: 'pool.profile_helper',
    profile: profileName,
    method,
    chainId: row.chain_id,
    poolAddress: row.pool_address
  });

  const [
    contributionSettings,
    vestingSettings,
    contributorCount,
    feeSettings,
    ownerViaGetter,
    ownerViaOwner,
    factory,
    router,
    version,
    implementationVersion,
    needCalculate,
    initialMarketCap,
    poolType,
    softCap,
    hardCap,
    minBuyScalar,
    maxBuyScalar,
    publicSaleStartTime,
    claimTime,
    poolDetails,
    kycDetails,
    totalSellingTokens,
    calculationStage
  ] = await Promise.all([
    safeCall(() => helperContract.getContributionSettings(), null, rpcMeta('getContributionSettings')),
    safeCall(() => helperContract.contributorVestingSettings(), null, rpcMeta('contributorVestingSettings')),
    safeCall(() => helperContract.getContributorCount(), null, rpcMeta('getContributorCount')),
    safeCall(() => helperContract.getFeeSettings(), null, rpcMeta('getFeeSettings')),
    safeCall(() => helperContract.getOwner(), null, rpcMeta('getOwner')),
    safeCall(() => helperContract.owner(), null, rpcMeta('owner')),
    safeCall(() => helperContract.factory(), null, rpcMeta('factory')),
    safeCall(() => helperContract.router(), null, rpcMeta('router')),
    safeCall(() => helperContract.version(), null, rpcMeta('version')),
    safeCall(() => helperContract.getImplementationVersion(), null, rpcMeta('getImplementationVersion')),
    safeCall(() => helperContract.needCalculate(), null, rpcMeta('needCalculate')),
    safeCall(() => helperContract.initialMarketCap(), null, rpcMeta('initialMarketCap')),
    safeCall(() => helperContract.poolType(), null, rpcMeta('poolType')),
    safeCall(() => helperContract.softCap(), null, rpcMeta('softCap')),
    safeCall(() => helperContract.hardCap(), null, rpcMeta('hardCap')),
    safeCall(() => helperContract.min(), null, rpcMeta('min')),
    safeCall(() => helperContract.max(), null, rpcMeta('max')),
    safeCall(() => helperContract.publicSaleStartTime(), null, rpcMeta('publicSaleStartTime')),
    safeCall(() => helperContract.claimTime(), null, rpcMeta('claimTime')),
    safeCall(() => helperContract.poolDetails(), null, rpcMeta('poolDetails')),
    safeCall(() => helperContract.kycDetails(), null, rpcMeta('kycDetails')),
    safeCall(() => helperContract.totalSellingTokens(), null, rpcMeta('totalSellingTokens')),
    safeCall(() => helperContract.calculationStage(), null, rpcMeta('calculationStage'))
  ]);

  return {
    minBuy:
      toStringValue(getTupleNamedOrIndexed(contributionSettings, 'min', 0)) ??
      toStringValue(minBuyScalar),
    maxBuy:
      toStringValue(getTupleNamedOrIndexed(contributionSettings, 'max', 1)) ??
      toStringValue(maxBuyScalar),
    contributorCount: toNumber(contributorCount, null),
    feeCurrency: toStringValue(getTupleNamedOrIndexed(feeSettings, 'currency', 0)),
    feeToken: toStringValue(getTupleNamedOrIndexed(feeSettings, 'token', 1)),
    poolOwner: toAddressValue(ownerViaOwner) ?? toAddressValue(ownerViaGetter),
    poolFactory: toAddressValue(factory),
    poolRouter: toAddressValue(router),
    poolVersion: toNumber(version ?? implementationVersion, null),
    poolNeedCalculate: typeof needCalculate === 'boolean' ? needCalculate : null,
    initialMarketCap: toStringValue(initialMarketCap),
    poolType: toNumber(poolType, null),
    softCap: toStringValue(softCap),
    hardCap: toStringValue(hardCap),
    publicSaleStartTime: normalizeUnixTimestamp(publicSaleStartTime),
    claimTime: normalizeUnixTimestamp(claimTime),
    totalSellingTokens: toStringValue(totalSellingTokens),
    poolDetails: stringifyIfObject(poolDetails),
    kycDetails: stringifyIfObject(kycDetails),
    calcStage: toNumber(getTupleNamedOrIndexed(calculationStage, 'stage', 0), null),
    calcCurrentIndex: toStringValue(getTupleNamedOrIndexed(calculationStage, 'currentIndex', 1)),
    calcFinishedAllocatingUserCount: toStringValue(
      getTupleNamedOrIndexed(calculationStage, 'finishedAllocatingUserCount', 2)
    ),
    calcDistributableRaised: toStringValue(
      getTupleNamedOrIndexed(calculationStage, 'distributableRaised', 3)
    ),
    calcExcessiveAllocations: toStringValue(
      getTupleNamedOrIndexed(calculationStage, 'excessiveAllocations', 4)
    ),
    calcTempDistributableRaised: toStringValue(
      getTupleNamedOrIndexed(calculationStage, 'tempDistributableRaised', 5)
    ),
    calcTempExcessiveAllocations: toStringValue(
      getTupleNamedOrIndexed(calculationStage, 'tempExcessiveAllocations', 6)
    ),
    vesting: {
      tgeReleasePct: toStringValue(getTupleNamedOrIndexed(vestingSettings, 'tgeReleasePct', 0)),
      cycleReleasePct: toStringValue(getTupleNamedOrIndexed(vestingSettings, 'cycleReleasePct', 1)),
      cycle: toStringValue(getTupleNamedOrIndexed(vestingSettings, 'cycle', 2))
    }
  };
}

function decodePinkSaleProfileData(profileName, rawSettingsHex, rawStatesHex) {
  const profile = PINKSALE_POOL_PROFILES[profileName];
  if (!profile || !rawSettingsHex || !rawStatesHex) return null;

  const settings = decodeTupleValue(profile.settingsSignature, rawSettingsHex);
  const states = decodeTupleValue(profile.statesSignature, rawStatesHex);
  if (!settings || !states) return null;

  const base = {
    sourceState: sourceStateFromPoolValue(settings == null ? null : getTupleNamedOrIndexed(states, 'state', 0)),
    currencyAddress: toAddressValue(getTupleNamedOrIndexed(settings, 'currency', 1)),
    startTime: null,
    endTime: null,
    publicSaleStartTime: null,
    claimTime: null,
    presaleRate: null,
    listingRate: null,
    softCap: null,
    hardCap: null,
    totalSellingTokens: null,
    totalRaised: null,
    totalCommitted: null,
    totalVolumePurchased: null,
    finishTime: null,
    liquidityUnlockTime: null,
    liquidityPercentage: null,
    buybackPercentage: null,
    initialMarketCap: null,
    contributorCount: null,
    poolLockId: null,
    poolType: null,
    poolDetails: null,
    kycDetails: null,
    metadataJson: null
  };

  switch (profileName) {
    case 'legacy_presale_v12':
      base.startTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'startTime', 4));
      base.endTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'endTime', 5));
      base.presaleRate = toStringValue(getTupleNamedOrIndexed(settings, 'rate', 6));
      base.softCap = toStringValue(getTupleNamedOrIndexed(settings, 'softCap', 7));
      base.hardCap = toStringValue(getTupleNamedOrIndexed(settings, 'hardCap', 8));
      base.listingRate = toStringValue(getTupleNamedOrIndexed(settings, 'liquidityListingRate', 9));
      base.liquidityPercentage = toNumber(getTupleNamedOrIndexed(settings, 'liquidityPercent', 11), null);
      base.finishTime = toStringValue(getTupleNamedOrIndexed(states, 'finishTime', 1));
      base.totalRaised = toStringValue(getTupleNamedOrIndexed(states, 'totalRaised', 2));
      base.totalVolumePurchased = toStringValue(getTupleNamedOrIndexed(states, 'totalVolumePurchased', 3));
      base.liquidityUnlockTime = toStringValue(getTupleNamedOrIndexed(states, 'liquidityUnlockTime', 4));
      base.poolLockId = toStringValue(getTupleNamedOrIndexed(states, 'lockId', 6));
      base.poolDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'poolDetails', 7));
      base.kycDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'kycDetails', 8));
      base.metadataJson = compactMetadata({
        profile: profileName,
        affliateProgram: toAddressValue(getTupleNamedOrIndexed(settings, 'affliateProgram', 2)),
        whitelistManager: toAddressValue(getTupleNamedOrIndexed(settings, 'whitelistManager', 3)),
        liquidityLockDays: toStringValue(getTupleNamedOrIndexed(settings, 'liquidityLockDays', 10)),
        refundType: toStringValue(getTupleNamedOrIndexed(settings, 'refundType', 12)),
        totalVestedTokens: toStringValue(getTupleNamedOrIndexed(states, 'totalVestedTokens', 5))
      });
      break;
    case 'subscription_v2':
      base.startTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'startTime', 3));
      base.endTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'endTime', 4));
      base.presaleRate = toStringValue(getTupleNamedOrIndexed(settings, 'rate', 5));
      base.listingRate = toStringValue(getTupleNamedOrIndexed(settings, 'listingRate', 6));
      base.softCap = toStringValue(getTupleNamedOrIndexed(settings, 'softCapTokens', 7));
      base.totalSellingTokens = toStringValue(getTupleNamedOrIndexed(settings, 'totalSellingTokens', 8));
      base.maxBuy = toStringValue(getTupleNamedOrIndexed(settings, 'hardCapTokensPerUser', 9));
      base.liquidityPercentage = toNumber(getTupleNamedOrIndexed(settings, 'liquidityPercent', 11), null);
      base.finishTime = toStringValue(getTupleNamedOrIndexed(states, 'finishTime', 1));
      base.totalRaised = toStringValue(getTupleNamedOrIndexed(states, 'totalRaised', 2));
      base.totalCommitted = toStringValue(getTupleNamedOrIndexed(states, 'totalCommitted', 3));
      base.totalVolumePurchased = toStringValue(getTupleNamedOrIndexed(states, 'totalVolumePurchased', 4));
      base.liquidityUnlockTime = toStringValue(getTupleNamedOrIndexed(states, 'liquidityUnlockTime', 5));
      base.poolLockId = toStringValue(getTupleNamedOrIndexed(states, 'lockId', 6));
      base.poolDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'poolDetails', 7));
      base.kycDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'kycDetails', 8));
      base.metadataJson = compactMetadata({
        profile: profileName,
        whitelistManager: toAddressValue(getTupleNamedOrIndexed(settings, 'whitelistManager', 2)),
        liquidityLockDays: toStringValue(getTupleNamedOrIndexed(settings, 'liquidityLockDays', 10)),
        refundType: toStringValue(getTupleNamedOrIndexed(settings, 'refundType', 12))
      });
      break;
    case 'manual_list_presale':
      base.startTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'startTime', 4));
      base.endTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'endTime', 5));
      base.presaleRate = toStringValue(getTupleNamedOrIndexed(settings, 'rate', 6));
      base.softCap = toStringValue(getTupleNamedOrIndexed(settings, 'softCap', 7));
      base.hardCap = toStringValue(getTupleNamedOrIndexed(settings, 'hardCap', 8));
      base.liquidityPercentage = toNumber(getTupleNamedOrIndexed(settings, 'liquidityPercent', 9), null);
      base.finishTime = toStringValue(getTupleNamedOrIndexed(states, 'finishTime', 1));
      base.totalRaised = toStringValue(getTupleNamedOrIndexed(states, 'totalRaised', 2));
      base.totalCommitted = toStringValue(getTupleNamedOrIndexed(states, 'totalCommitted', 3));
      base.totalVolumePurchased = toStringValue(getTupleNamedOrIndexed(states, 'totalVolumePurchased', 4));
      base.poolDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'poolDetails', 5));
      base.kycDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'kycDetails', 6));
      base.metadataJson = compactMetadata({
        profile: profileName,
        affliateProgram: toAddressValue(getTupleNamedOrIndexed(settings, 'affliateProgram', 2)),
        whitelistManager: toAddressValue(getTupleNamedOrIndexed(settings, 'whitelistManager', 3)),
        refundType: toStringValue(getTupleNamedOrIndexed(settings, 'refundType', 10))
      });
      break;
    case 'overflow_pool_type':
      base.startTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'startTime', 2));
      base.endTime = normalizeUnixTimestamp(getTupleNamedOrIndexed(settings, 'endTime', 3));
      base.softCap = toStringValue(getTupleNamedOrIndexed(settings, 'softCap', 4));
      base.hardCap = toStringValue(getTupleNamedOrIndexed(settings, 'hardCap', 5));
      base.totalSellingTokens = toStringValue(getTupleNamedOrIndexed(settings, 'totalSellingTokens', 6));
      base.presaleRate = toStringValue(getTupleNamedOrIndexed(settings, 'rate', 7));
      base.listingRate = toStringValue(getTupleNamedOrIndexed(settings, 'listingRate', 8));
      base.liquidityPercentage = toNumber(getTupleNamedOrIndexed(settings, 'liquidityPercent', 10), null);
      base.poolType = toNumber(getTupleNamedOrIndexed(settings, 'poolType', 12), null);
      base.finishTime = toStringValue(getTupleNamedOrIndexed(states, 'finishTime', 2));
      base.totalRaised = toStringValue(getTupleNamedOrIndexed(states, 'totalRaised', 3));
      base.totalCommitted = toStringValue(getTupleNamedOrIndexed(states, 'totalCommitted', 4));
      base.liquidityUnlockTime = toStringValue(getTupleNamedOrIndexed(states, 'liquidityUnlockTime', 5));
      base.poolLockId = toStringValue(getTupleNamedOrIndexed(states, 'lockId', 6));
      base.poolDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'poolDetails', 7));
      base.kycDetails = stringifyIfObject(getTupleNamedOrIndexed(states, 'kycDetails', 8));
      base.calcStage = toNumber(getTupleNamedOrIndexed(states, 'calculationState', 1), null);
      base.metadataJson = compactMetadata({
        profile: profileName,
        liquidityLockDays: toStringValue(getTupleNamedOrIndexed(settings, 'liquidityLockDays', 9)),
        refundType: toStringValue(getTupleNamedOrIndexed(settings, 'refundType', 11)),
        allocationRoot: toStringValue(getTupleNamedOrIndexed(states, 'allocationRoot', 9)),
        noAllocationRoot: toStringValue(getTupleNamedOrIndexed(states, 'noAllocationRoot', 10))
      });
      break;
    default:
      return null;
  }

  return base;
}

function mergePoolData(base, helper) {
  const metadataParts = [];
  for (const value of [base?.metadataJson, compactMetadata({
    vestingTgeReleasePct: helper?.vesting?.tgeReleasePct,
    vestingCycleReleasePct: helper?.vesting?.cycleReleasePct,
    vestingCycle: helper?.vesting?.cycle
  })]) {
    if (value) {
      try {
        metadataParts.push(JSON.parse(value));
      } catch {
        // ignore invalid metadata fragments
      }
    }
  }

  return {
    ...base,
    minBuy: helper?.minBuy ?? base?.minBuy ?? null,
    maxBuy: helper?.maxBuy ?? base?.maxBuy ?? null,
    softCap: base?.softCap ?? helper?.softCap ?? null,
    hardCap: base?.hardCap ?? helper?.hardCap ?? null,
    totalSellingTokens: base?.totalSellingTokens ?? helper?.totalSellingTokens ?? null,
    initialMarketCap: helper?.initialMarketCap ?? base?.initialMarketCap ?? null,
    contributorCount: helper?.contributorCount ?? base?.contributorCount ?? null,
    poolOwner: helper?.poolOwner ?? base?.poolOwner ?? null,
    poolFactory: helper?.poolFactory ?? base?.poolFactory ?? null,
    poolRouter: helper?.poolRouter ?? base?.poolRouter ?? null,
    poolVersion: helper?.poolVersion ?? base?.poolVersion ?? null,
    poolNeedCalculate: helper?.poolNeedCalculate ?? base?.poolNeedCalculate ?? null,
    feeCurrency: helper?.feeCurrency ?? base?.feeCurrency ?? null,
    feeToken: helper?.feeToken ?? base?.feeToken ?? null,
    publicSaleStartTime: helper?.publicSaleStartTime ?? base?.publicSaleStartTime ?? null,
    claimTime: helper?.claimTime ?? base?.claimTime ?? null,
    poolDetails: base?.poolDetails ?? helper?.poolDetails ?? null,
    kycDetails: base?.kycDetails ?? helper?.kycDetails ?? null,
    calcStage: helper?.calcStage ?? base?.calcStage ?? null,
    calcCurrentIndex: helper?.calcCurrentIndex ?? base?.calcCurrentIndex ?? null,
    calcFinishedAllocatingUserCount:
      helper?.calcFinishedAllocatingUserCount ?? base?.calcFinishedAllocatingUserCount ?? null,
    calcDistributableRaised:
      helper?.calcDistributableRaised ?? base?.calcDistributableRaised ?? null,
    calcExcessiveAllocations:
      helper?.calcExcessiveAllocations ?? base?.calcExcessiveAllocations ?? null,
    calcTempDistributableRaised:
      helper?.calcTempDistributableRaised ?? base?.calcTempDistributableRaised ?? null,
    calcTempExcessiveAllocations:
      helper?.calcTempExcessiveAllocations ?? base?.calcTempExcessiveAllocations ?? null,
    poolType: helper?.poolType ?? base?.poolType ?? null,
    metadataJson: compactMetadata(
      metadataParts.reduce((acc, part) => Object.assign(acc, part), {})
    )
  };
}

async function readPoolDataWithPinkSaleProfile(row, provider) {
  const rpcMeta = (method) => ({
    stage: 'pool.profile_raw',
    method,
    chainId: row.chain_id,
    poolAddress: row.pool_address
  });

  const [rawSettings, rawStates] = await Promise.all([
    safeCall(() => callPoolRawView(provider, row, 'poolSettings'), null, rpcMeta('poolSettings')),
    safeCall(() => callPoolRawView(provider, row, 'poolStates'), null, rpcMeta('poolStates'))
  ]);

  if (!rawSettings || !rawStates) return null;

  const detectedProfile = detectPinkSaleProfileFromSettings(rawSettings, row.chain_id);
  const profileOrder = [
    detectedProfile,
    ...getPoolAbiOrder(row.chain_id).filter((profile) => profile !== 'legacy_scalar')
  ].filter((profile, index, values) => profile && values.indexOf(profile) === index);

  let decoded = null;
  let profileName = null;
  for (const candidate of profileOrder) {
    decoded = decodePinkSaleProfileData(candidate, rawSettings, rawStates);
    if (decoded) {
      profileName = candidate;
      break;
    }
  }
  if (!decoded || !profileName) return null;

  const helper = await readPinkSaleHelperData(row, provider, profileName);
  return mergePoolData(decoded, helper);
}

async function readPoolDataWithLegacyScalars(row, provider) {
  const poolLegacyContract = new Contract(
    row.pool_address,
    [...PINKSALE_LAUNCHPAD_LEGACY_SCALAR_ABI, ...PINKSALE_POOL_HELPER_ABI],
    provider
  );
  const rpcMeta = (method) => ({
    stage: 'pool.legacy',
    method,
    chainId: row.chain_id,
    poolAddress: row.pool_address
  });

  const [
    sourceState,
    poolType,
    currencyAddress,
    startTime,
    endTime,
    publicSaleStartTime,
    claimTime,
    presaleRate,
    listingRate,
    softCap,
    hardCap,
    minBuy,
    maxBuy,
    totalRaised,
    totalCommitted,
    totalVolumePurchased,
    totalSellingTokens,
    finishTime,
    liquidityUnlockTime,
    liquidityPercentageRaw,
    liquidityPercentRaw,
    buybackPercentage,
    initialMarketCap,
    contributorCount,
    poolOwner,
    poolFactory,
    poolRouter,
    poolVersion,
    poolNeedCalculate,
    calculationStage,
    feeSettings,
    poolDetails,
    kycDetails
  ] = await Promise.all([
    safeCall(() => poolLegacyContract.state(), null, rpcMeta('state')),
    safeCall(() => poolLegacyContract.poolType(), null, rpcMeta('poolType')),
    safeCall(() => poolLegacyContract.currency(), null, rpcMeta('currency')),
    safeCall(() => poolLegacyContract.startTime(), null, rpcMeta('startTime')),
    safeCall(() => poolLegacyContract.endTime(), null, rpcMeta('endTime')),
    safeCall(() => poolLegacyContract.publicSaleStartTime(), null, rpcMeta('publicSaleStartTime')),
    safeCall(() => poolLegacyContract.claimTime(), null, rpcMeta('claimTime')),
    safeCall(() => poolLegacyContract.rate(), null, rpcMeta('rate')),
    safeCall(() => poolLegacyContract.listingRate(), null, rpcMeta('listingRate')),
    safeCall(() => poolLegacyContract.softCap(), null, rpcMeta('softCap')),
    safeCall(() => poolLegacyContract.hardCap(), null, rpcMeta('hardCap')),
    safeCall(() => poolLegacyContract.min(), null, rpcMeta('min')),
    safeCall(() => poolLegacyContract.max(), null, rpcMeta('max')),
    safeCall(() => poolLegacyContract.totalRaised(), null, rpcMeta('totalRaised')),
    safeCall(() => poolLegacyContract.totalCommitted(), null, rpcMeta('totalCommitted')),
    safeCall(() => poolLegacyContract.totalVolumePurchased(), null, rpcMeta('totalVolumePurchased')),
    safeCall(() => poolLegacyContract.totalSellingTokens(), null, rpcMeta('totalSellingTokens')),
    safeCall(() => poolLegacyContract.finishTime(), null, rpcMeta('finishTime')),
    safeCall(() => poolLegacyContract.liquidityUnlockTime(), null, rpcMeta('liquidityUnlockTime')),
    safeCall(() => poolLegacyContract.liquidityPercentage(), null, rpcMeta('liquidityPercentage')),
    safeCall(() => poolLegacyContract.liquidityPercent(), null, rpcMeta('liquidityPercent')),
    safeCall(() => poolLegacyContract.buybackPercentage(), null, rpcMeta('buybackPercentage')),
    safeCall(() => poolLegacyContract.initialMarketCap(), null, rpcMeta('initialMarketCap')),
    safeCall(() => poolLegacyContract.getContributorCount(), null, rpcMeta('getContributorCount')),
    safeCall(() => poolLegacyContract.owner(), null, rpcMeta('owner')),
    safeCall(() => poolLegacyContract.factory(), null, rpcMeta('factory')),
    safeCall(() => poolLegacyContract.router(), null, rpcMeta('router')),
    safeCall(() => poolLegacyContract.version(), null, rpcMeta('version')),
    safeCall(() => poolLegacyContract.needCalculate(), null, rpcMeta('needCalculate')),
    safeCall(() => poolLegacyContract.calculationStage(), null, rpcMeta('calculationStage')),
    safeCall(() => poolLegacyContract.getFeeSettings(), null, rpcMeta('getFeeSettings')),
    safeCall(() => poolLegacyContract.poolDetails(), null, rpcMeta('poolDetails')),
    safeCall(() => poolLegacyContract.kycDetails(), null, rpcMeta('kycDetails'))
  ]);

  const resolvedLiquidityPercentage = liquidityPercentageRaw ?? liquidityPercentRaw;

  return {
    sourceState: sourceStateFromPoolValue(sourceState),
    poolType: toNumber(poolType, null),
    finishTime: toStringValue(finishTime),
    totalRaised: toStringValue(totalRaised),
    totalCommitted: toStringValue(totalCommitted),
    totalVolumePurchased: toStringValue(totalVolumePurchased),
    liquidityUnlockTime: toStringValue(liquidityUnlockTime),
    poolDetails: stringifyIfObject(poolDetails),
    kycDetails: stringifyIfObject(kycDetails),
    currencyAddress: toAddressValue(currencyAddress),
    startTime: normalizeUnixTimestamp(startTime),
    endTime: normalizeUnixTimestamp(endTime),
    presaleRate: toStringValue(presaleRate),
    listingRate: toStringValue(listingRate),
    softCap: toStringValue(softCap),
    hardCap: toStringValue(hardCap),
    minBuy: toStringValue(minBuy),
    maxBuy: toStringValue(maxBuy),
    totalSellingTokens: toStringValue(totalSellingTokens),
    initialMarketCap: toStringValue(initialMarketCap),
    contributorCount: toNumber(contributorCount, null),
    poolLockId: null,
    poolOwner: toAddressValue(poolOwner),
    poolFactory: toAddressValue(poolFactory),
    poolRouter: toAddressValue(poolRouter),
    poolVersion: toNumber(poolVersion, null),
    poolNeedCalculate:
      typeof poolNeedCalculate === 'boolean' ? poolNeedCalculate : null,
    feeCurrency: toStringValue(feeSettings?.currency ?? feeSettings?.[0]),
    feeToken: toStringValue(feeSettings?.token ?? feeSettings?.[1]),
    calcStage: toNumber(calculationStage?.stage ?? calculationStage?.[0], null),
    calcCurrentIndex: toStringValue(
      calculationStage?.currentIndex ?? calculationStage?.[1]
    ),
    calcFinishedAllocatingUserCount: toStringValue(
      calculationStage?.finishedAllocatingUserCount ?? calculationStage?.[2]
    ),
    calcDistributableRaised: toStringValue(
      calculationStage?.distributableRaised ?? calculationStage?.[3]
    ),
    calcExcessiveAllocations: toStringValue(
      calculationStage?.excessiveAllocations ?? calculationStage?.[4]
    ),
    calcTempDistributableRaised: toStringValue(
      calculationStage?.tempDistributableRaised ?? calculationStage?.[5]
    ),
    calcTempExcessiveAllocations: toStringValue(
      calculationStage?.tempExcessiveAllocations ?? calculationStage?.[6]
    ),
    claimTime: normalizeUnixTimestamp(claimTime),
    publicSaleStartTime: normalizeUnixTimestamp(publicSaleStartTime),
    liquidityPercentage: toNumber(resolvedLiquidityPercentage, null),
    buybackPercentage: toNumber(buybackPercentage, null),
    metadataJson: null
  };
}

async function readBestPoolData(row, chain, provider) {
  const abiOrder = getPoolAbiOrder(chain);
  let best = { score: -1, data: null };

  for (const profile of abiOrder) {
    const data =
      profile === 'legacy_scalar'
        ? await readPoolDataWithLegacyScalars(row, provider)
        : await readPoolDataWithPinkSaleProfile(row, provider);
    const score = getPoolDataScore(data);
    if (score > best.score) {
      best = { score, data };
    }
    if (score >= 8) {
      break;
    }
  }

  return best.data;
}

async function withTimeout(promise, timeoutMs, message = 'Timed out') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchContractCreationTxHash(chainId, poolAddress) {
  const scan = CHAIN_SCAN_CONFIG[Number(chainId)];
  if (!scan?.baseUrl) return null;

  const url = new URL(scan.baseUrl);
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getcontractcreation');
  url.searchParams.set('contractaddresses', poolAddress);

  const apiKey = process.env[scan.apiKeyEnv] || '';
  if (apiKey) {
    url.searchParams.set('apikey', apiKey);
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  const result = Array.isArray(json?.result) ? json.result[0] : json?.result;
  const txHash = result?.txHash || result?.txhash || null;
  return txHash ? String(txHash) : null;
}

function hasDeployedCode(code) {
  return typeof code === 'string' && code !== '0x' && code !== '0x0';
}

async function getCodeAtBlock(provider, address, blockNumber) {
  return safeCall(
    () =>
      withTimeout(
        provider.getCode(address, blockNumber),
        RPC_PROBE_TIMEOUT_MS,
        `getCode timeout for block ${blockNumber}`
      ),
    null,
    {
      stage: 'created_time',
      method: 'getCode',
      address,
      blockNumber
    }
  );
}

async function getBlockTimestamp(chainId, provider, blockNumber, blockTsCache) {
  const blockKey = `${chainId}:${blockNumber}`;
  if (blockTsCache.has(blockKey)) {
    return blockTsCache.get(blockKey);
  }

  const block = await safeCall(
    () =>
      withTimeout(
        provider.getBlock(blockNumber),
        RPC_PROBE_TIMEOUT_MS,
        `getBlock timeout for block ${blockNumber}`
      ),
    null,
    {
      stage: 'created_time',
      method: 'getBlock',
      chainId,
      blockNumber
    }
  );
  const createdAt = Number(block?.timestamp);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

  blockTsCache.set(blockKey, createdAt);
  return createdAt;
}

async function resolveContractCreatedAtByBinarySearch(
  chainId,
  poolAddress,
  providerCache,
  blockTsCache
) {
  const provider = await getProviderForChain(chainId, providerCache);
  if (!provider) return null;

  const normalized = normalizePoolAddress(poolAddress);
  if (!normalized) return null;

  const latestBlock = Number(
    await safeCall(
      () =>
        withTimeout(
          provider.getBlockNumber(),
          RPC_PROBE_TIMEOUT_MS,
          `getBlockNumber timeout for chain ${chainId}`
        ),
      null,
      {
        stage: 'created_time',
        method: 'getBlockNumber',
        chainId,
        poolAddress
      }
    )
  );
  if (!Number.isFinite(latestBlock) || latestBlock < 0) return null;

  const latestCode = await getCodeAtBlock(provider, normalized, latestBlock);
  if (latestCode == null) return null;
  if (!hasDeployedCode(latestCode)) return null;

  let low = 0;
  let high = latestBlock;
  let firstDeployedBlock = latestBlock;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const code = await getCodeAtBlock(provider, normalized, mid);
    if (code == null) {
      // RPC likely does not support historical state reads for this chain/provider.
      return null;
    }

    if (hasDeployedCode(code)) {
      firstDeployedBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return getBlockTimestamp(chainId, provider, firstDeployedBlock, blockTsCache);
}

async function resolveContractCreatedAtByScanner(chainId, poolAddress, providerCache, blockTsCache) {
  const txHash = await fetchContractCreationTxHash(chainId, poolAddress);
  if (!txHash) return null;

  const provider = await getProviderForChain(chainId, providerCache);
  if (!provider) return null;

  const receipt = await safeCall(() => provider.getTransactionReceipt(txHash), null, {
    stage: 'created_time',
    method: 'getTransactionReceipt',
    chainId,
    poolAddress,
    txHash
  });
  const blockNumber = Number(receipt?.blockNumber);
  if (!Number.isFinite(blockNumber)) return null;

  return getBlockTimestamp(chainId, provider, blockNumber, blockTsCache);
}

async function resolveContractCreatedAt(chainId, poolAddress, providerCache, blockTsCache) {
  // Primary path: pure RPC binary search (no explorer dependency).
  const viaRpc = await resolveContractCreatedAtByBinarySearch(
    chainId,
    poolAddress,
    providerCache,
    blockTsCache
  );
  if (viaRpc) return viaRpc;

  // Fallback path: scanner contract-creation endpoint when available.
  return resolveContractCreatedAtByScanner(chainId, poolAddress, providerCache, blockTsCache);
}

export async function enrichPoolCreatedTimes({
  batchSize = 1000,
  maxBatches = Number.POSITIVE_INFINITY
} = {}) {
  const perBatch = Math.min(5000, Math.max(1, Number(batchSize) || 1000));
  const maxBatchCount = Number.isFinite(Number(maxBatches))
    ? Math.max(1, Number(maxBatches))
    : Number.POSITIVE_INFINITY;

  const providerCache = new Map();
  const blockTsCache = new Map();
  const chainNextAllowedAt = new Map();

  let batches = 0;
  let processed = 0;
  let updated = 0;
  let errors = 0;
  let skippedUnsupportedChain = 0;

  while (batches < maxBatchCount) {
    const rows = listPoolsMissingContractCreatedAt({ limit: perBatch });
    if (!rows.length) break;

    for (const row of rows) {
      processed += 1;
      const chainId = Number(row.chain_id);
      const poolAddress = normalizePoolAddress(row.pool_address);

      if (!isChainEnabledForEnrich(chainId)) {
        skippedUnsupportedChain += 1;
        continue;
      }
      if (!isEvmChain(chainId)) {
        skippedUnsupportedChain += 1;
        continue;
      }
      if (isTemporarilyUnavailableChain(chainId)) {
        skippedUnsupportedChain += 1;
        continue;
      }

      try {
        await waitForChainRateLimit(
          chainId,
          getCreatedTimeDelayMs(chainId, CREATED_TIME_CALL_DELAY_MS),
          chainNextAllowedAt
        );
        const createdAt = await resolveContractCreatedAt(
          chainId,
          poolAddress,
          providerCache,
          blockTsCache
        );
        if (!createdAt) continue;

        updatePoolContractCreatedAt({
          chainId,
          poolAddress,
          contractCreatedAt: createdAt
        });
        updated += 1;
      } catch {
        errors += 1;
      }

      if (processed % ENRICH_PROGRESS_EVERY === 0) {
        console.log(
          `[enrich-created-time] processed=${processed} updated=${updated} errors=${errors} remaining≈${Math.max(0, rows.length - (processed % perBatch))}`
        );
      }
    }

    batches += 1;
  }

  const remainingMissing = getDb()
    .prepare(
      'SELECT COUNT(*) AS total FROM pools WHERE contract_created_at IS NULL OR contract_created_at <= 0'
    )
    .get()?.total;

  return {
    db: dbMeta(),
    batchSize: perBatch,
    batches,
    processed,
    updated,
    errors,
    skippedUnsupportedChain,
    remainingMissing: Number(remainingMissing || 0)
  };
}

async function enrichSolanaRow(row) {
  const mint = String(row.token_address || '').trim();
  const poolAddress = String(row.pool_address || '').trim();
  if (!mint) return { tokenUpdated: false, poolUpdated: false, error: false };

  const tokenSupply = await safeCall(
    () => callNonEvmRpc('solana', 'getTokenSupply', [mint]),
    null,
    {
      stage: 'non_evm.solana',
      method: 'getTokenSupply',
      chainId: row.chain_id,
      tokenAddress: mint
    }
  );
  const amount = tokenSupply?.result?.value?.amount ?? null;
  const decimals = tokenSupply?.result?.value?.decimals ?? null;

  if (amount != null || decimals != null) {
    updateTokenEnrichment({
      chainId: row.chain_id,
      tokenAddress: row.token_address,
      name: null,
      symbol: null,
      decimals,
      totalSupply: amount != null ? String(amount) : null
    });
  }

  let normalizedRaised = null;
  if (poolAddress) {
    const balance = await safeCall(
      () => callNonEvmRpc('solana', 'getBalance', [poolAddress, { commitment: 'confirmed' }]),
      null,
      {
        stage: 'non_evm.solana',
        method: 'getBalance',
        chainId: row.chain_id,
        poolAddress
      }
    );
    const lamports =
      balance?.result && typeof balance.result.value === 'number'
        ? balance.result.value
        : null;

    if (lamports != null) {
      normalizedRaised = String(lamports);
      updatePoolEnrichment({
        chainId: row.chain_id,
        poolAddress: row.pool_address,
        sourceState: null,
        totalRaised: normalizedRaised,
        totalCommitted: null,
        totalVolumePurchased: null,
        finishTime: null,
        liquidityUnlockTime: null
      });
    }
  }

  return {
    tokenUpdated: amount != null || decimals != null,
    poolUpdated: normalizedRaised != null,
    error: false
  };
}

function isMissingValue(value) {
  return value == null || String(value).trim() === '';
}

function shouldEnrichOnDemand(row) {
  if (!row) return false;

  const missingToken =
    isMissingValue(row.name) ||
    isMissingValue(row.symbol) ||
    row.decimals == null ||
    row.total_supply == null;

  const missingPool =
    row.source_state == null ||
    isMissingValue(row.currency_address) ||
    isMissingValue(row.presale_rate) ||
    isMissingValue(row.soft_cap) ||
    (isMissingValue(row.total_selling_tokens) && isMissingValue(row.metadata_json)) ||
    row.start_time == null ||
    row.end_time == null;

  return missingToken || missingPool;
}

export async function enrichPoolOnDemand({
  chainId,
  poolAddress,
  includeNonEvm = true
}) {
  const chain = Number(chainId);
  const address = String(poolAddress || '').trim().toLowerCase();
  if (!Number.isFinite(chain) || !address) {
    return { ok: false, refreshed: false, reason: 'invalid_input' };
  }

  const row = getPoolByChainAndAddress({ chainId: chain, poolAddress: address });
  if (!row) {
    return { ok: false, refreshed: false, reason: 'not_found' };
  }

  if (!shouldEnrichOnDemand(row)) {
    return { ok: true, refreshed: false, reason: 'already_present' };
  }

  if (isTemporarilyUnavailableChain(chain)) {
    return { ok: true, refreshed: false, reason: 'temporarily_unavailable_chain' };
  }

  if (!isEvmChain(chain)) {
    const nonEvmChain = resolveNonEvmChain(String(chain));
    if (includeNonEvm && nonEvmChain === 'solana') {
      await enrichSolanaRow(row);
      return { ok: true, refreshed: true, reason: 'enriched_non_evm' };
    }
    return { ok: true, refreshed: false, reason: 'unsupported_non_evm' };
  }

  const providerCache = new Map();
  const chainNextAllowedAt = new Map();
  const provider = await getProviderForChain(chain, providerCache);
  if (!provider) {
    return { ok: false, refreshed: false, reason: 'provider_unavailable' };
  }

  const tokenContract = new Contract(row.token_address, PINKSALE_ERC20_ABI, provider);
  await waitForChainRateLimit(
    chain,
    getEvmEnrichDelayMs(chain, EVM_ENRICH_CALL_DELAY_MS),
    chainNextAllowedAt
  );
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    safeCall(() => tokenContract.name(), null, {
      stage: 'token.on_demand',
      method: 'name',
      chainId: chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address
    }),
    safeCall(() => tokenContract.symbol(), null, {
      stage: 'token.on_demand',
      method: 'symbol',
      chainId: chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address
    }),
    safeCall(() => tokenContract.decimals(), null, {
      stage: 'token.on_demand',
      method: 'decimals',
      chainId: chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address
    }),
    safeCall(() => tokenContract.totalSupply(), null, {
      stage: 'token.on_demand',
      method: 'totalSupply',
      chainId: chain,
      tokenAddress: row.token_address,
      poolAddress: row.pool_address
    })
  ]);

  updateTokenEnrichment({
    chainId: chain,
    tokenAddress: row.token_address,
    name: typeof name === 'string' ? name : null,
    symbol: typeof symbol === 'string' ? symbol : null,
    decimals: decimals != null ? Number(decimals) : null,
    totalSupply: totalSupply != null ? totalSupply.toString() : null
  });

  await waitForChainRateLimit(
    chain,
    getEvmEnrichDelayMs(chain, EVM_ENRICH_CALL_DELAY_MS),
    chainNextAllowedAt
  );
  const poolData = await readBestPoolData(row, chain, provider);
  const currencyMetadata =
    poolData?.currencyAddress &&
    (!row.currency_name ||
      !row.currency_symbol ||
      row.currency_decimals == null ||
      row.currency_total_supply == null)
      ? await enrichCurrencyMetadata(poolData.currencyAddress, provider)
      : {
          currencyName: null,
          currencySymbol: null,
          currencyDecimals: null,
          currencyTotalSupply: null
        };

  updatePoolEnrichment({
    chainId: chain,
    poolAddress: row.pool_address,
    sourceState: poolData?.sourceState,
    poolType: poolData?.poolType ?? null,
    minBuy: poolData?.minBuy ?? null,
    maxBuy: poolData?.maxBuy ?? null,
    currencyAddress: poolData?.currencyAddress ?? null,
    currencyName: currencyMetadata.currencyName,
    currencySymbol: currencyMetadata.currencySymbol,
    currencyDecimals: currencyMetadata.currencyDecimals,
    currencyTotalSupply: currencyMetadata.currencyTotalSupply,
    feeCurrency: poolData?.feeCurrency ?? null,
    feeToken: poolData?.feeToken ?? null,
    presaleRate: poolData?.presaleRate ?? null,
    listingRate: poolData?.listingRate ?? null,
    softCap: poolData?.softCap ?? null,
    hardCap: poolData?.hardCap ?? null,
    totalSellingTokens: poolData?.totalSellingTokens ?? null,
    totalRaised: poolData?.totalRaised ?? null,
    totalCommitted: poolData?.totalCommitted ?? null,
    totalVolumePurchased: poolData?.totalVolumePurchased ?? null,
    startTime: poolData?.startTime ?? null,
    endTime: poolData?.endTime ?? null,
    publicSaleStartTime: poolData?.publicSaleStartTime ?? null,
    finishTime: poolData?.finishTime ?? null,
    claimTime: poolData?.claimTime ?? null,
    liquidityUnlockTime: poolData?.liquidityUnlockTime ?? null,
    liquidityPercentage: poolData?.liquidityPercentage ?? null,
    buybackPercentage: poolData?.buybackPercentage ?? null,
    initialMarketCap: poolData?.initialMarketCap ?? null,
    contributorCount: poolData?.contributorCount ?? null,
    poolLockId: poolData?.poolLockId ?? null,
    poolOwner: poolData?.poolOwner ?? null,
    poolFactory: poolData?.poolFactory ?? null,
    poolRouter: poolData?.poolRouter ?? null,
    poolVersion: poolData?.poolVersion ?? null,
    poolNeedCalculate: poolData?.poolNeedCalculate ?? null,
    calcStage: poolData?.calcStage ?? null,
    calcCurrentIndex: poolData?.calcCurrentIndex ?? null,
    calcFinishedAllocatingUserCount:
      poolData?.calcFinishedAllocatingUserCount ?? null,
    calcDistributableRaised: poolData?.calcDistributableRaised ?? null,
    calcExcessiveAllocations: poolData?.calcExcessiveAllocations ?? null,
    calcTempDistributableRaised:
      poolData?.calcTempDistributableRaised ?? null,
    calcTempExcessiveAllocations:
      poolData?.calcTempExcessiveAllocations ?? null,
    poolDetails: poolData?.poolDetails ?? null,
    kycDetails: poolData?.kycDetails ?? null,
    metadataJson: poolData?.metadataJson ?? null
  });

  return { ok: true, refreshed: true, reason: 'enriched_evm' };
}

export async function enrichEvmContracts({
  onlyMissing = true,
  strategy = 'missing',
  limit = 200,
  includeNonEvm = true,
  minDynamicRecheckAgeSec = Math.max(
    0,
    Number(process.env.DYNAMIC_RECHECK_INTERVAL_SEC || 600)
  )
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = listPoolsForEnrichment({
    onlyMissing,
    strategy,
    limit,
    nowSec,
    excludeChainIds: TEMP_UNAVAILABLE_CHAIN_IDS,
    minDynamicRecheckAgeSec
  });

  const providerCache = new Map();
  const chainNextAllowedAt = new Map();
  const results = {
    db: dbMeta(),
    scanned: candidates.length,
    evmCandidates: 0,
    updatedTokens: 0,
    updatedPools: 0,
    skippedNonEvm: 0,
    updatedNonEvmTokens: 0,
    updatedNonEvmPools: 0,
    nonEvmErrors: 0,
    errors: 0
  };

  for (const row of candidates) {
    const chainId = Number(row.chain_id);
    if (!isChainEnabledForEnrich(chainId)) {
      results.skippedNonEvm += 1;
      continue;
    }
    if (isTemporarilyUnavailableChain(chainId)) {
      results.skippedNonEvm += 1;
      continue;
    }
    if (!isEvmChain(chainId)) {
      const nonEvmChain = resolveNonEvmChain(String(chainId));
      if (!includeNonEvm || !nonEvmChain) {
        results.skippedNonEvm += 1;
        continue;
      }

      if (nonEvmChain === 'solana') {
        const nonEvmResult = await enrichSolanaRow(row);
        if (nonEvmResult.error) {
          results.nonEvmErrors += 1;
        }
        if (nonEvmResult.tokenUpdated) {
          results.updatedNonEvmTokens += 1;
        }
        if (nonEvmResult.poolUpdated) {
          results.updatedNonEvmPools += 1;
        }
        if (strategy === 'dynamic') {
          markPoolDynamicChecked({
            chainId: row.chain_id,
            poolAddress: row.pool_address,
            checkedAtSec: nowSec
          });
        }
      } else {
        results.skippedNonEvm += 1;
      }
      continue;
    }

    const provider = await getProviderForChain(chainId, providerCache);
    if (!provider) {
      results.errors += 1;
      continue;
    }

    results.evmCandidates += 1;

    try {
      const tokenContract = new Contract(row.token_address, PINKSALE_ERC20_ABI, provider);
      const tokenMissing =
        !row.name || !row.symbol || row.decimals == null || row.total_supply == null;
      const shouldRefreshToken = strategy === 'all' || onlyMissing || tokenMissing;
      const sourceState = Number(row.source_state);
      const isFinalState = sourceState === 1 || sourceState === 2;
      const rowEndTime = Number(row.end_time);
      const endedByTime =
        Number.isFinite(rowEndTime) && rowEndTime > 0 && rowEndTime <= nowSec;
      const postEndChecked = row.post_end_checked_at != null;
      const needsPostEndRefresh = endedByTime && !postEndChecked;
      const isActiveWindow = !endedByTime;
      const shouldRefreshPool =
        strategy === 'all' ||
        (isActiveWindow && !isFinalState) ||
        needsPostEndRefresh;

      // Hit token contract first (when required).
      if (shouldRefreshToken) {
        await waitForChainRateLimit(
          chainId,
          getEvmEnrichDelayMs(chainId, EVM_ENRICH_CALL_DELAY_MS),
          chainNextAllowedAt
        );
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          safeCall(() => tokenContract.name(), null, {
            stage: 'token.enrich',
            method: 'name',
            chainId,
            tokenAddress: row.token_address,
            poolAddress: row.pool_address
          }),
          safeCall(() => tokenContract.symbol(), null, {
            stage: 'token.enrich',
            method: 'symbol',
            chainId,
            tokenAddress: row.token_address,
            poolAddress: row.pool_address
          }),
          safeCall(() => tokenContract.decimals(), null, {
            stage: 'token.enrich',
            method: 'decimals',
            chainId,
            tokenAddress: row.token_address,
            poolAddress: row.pool_address
          }),
          safeCall(() => tokenContract.totalSupply(), null, {
            stage: 'token.enrich',
            method: 'totalSupply',
            chainId,
            tokenAddress: row.token_address,
            poolAddress: row.pool_address
          })
        ]);

        updateTokenEnrichment({
          chainId,
          tokenAddress: row.token_address,
          name: typeof name === 'string' ? name : null,
          symbol: typeof symbol === 'string' ? symbol : null,
          decimals: decimals != null ? Number(decimals) : null,
          totalSupply: totalSupply != null ? totalSupply.toString() : null
        });
        results.updatedTokens += 1;
      }

      if (!shouldRefreshPool) {
        continue;
      }

      // Then hit pool contract (chain-profile aware ABI with fallback).
      await waitForChainRateLimit(
        chainId,
        getEvmEnrichDelayMs(chainId, EVM_ENRICH_CALL_DELAY_MS),
        chainNextAllowedAt
      );
      const poolData = await readBestPoolData(row, chainId, provider);
      const currencyMetadata =
        poolData?.currencyAddress &&
        (!row.currency_name ||
          !row.currency_symbol ||
          row.currency_decimals == null ||
          row.currency_total_supply == null)
          ? await enrichCurrencyMetadata(poolData.currencyAddress, provider)
          : {
              currencyName: null,
              currencySymbol: null,
              currencyDecimals: null,
              currencyTotalSupply: null
            };

      updatePoolEnrichment({
        chainId,
        poolAddress: row.pool_address,
        sourceState: poolData?.sourceState,
        poolType: poolData?.poolType ?? null,
        minBuy: poolData?.minBuy ?? null,
        maxBuy: poolData?.maxBuy ?? null,
        currencyAddress: poolData?.currencyAddress ?? null,
        currencyName: currencyMetadata.currencyName,
        currencySymbol: currencyMetadata.currencySymbol,
        currencyDecimals: currencyMetadata.currencyDecimals,
        currencyTotalSupply: currencyMetadata.currencyTotalSupply,
        feeCurrency: poolData?.feeCurrency ?? null,
        feeToken: poolData?.feeToken ?? null,
        presaleRate: poolData?.presaleRate ?? null,
        listingRate: poolData?.listingRate ?? null,
        softCap: poolData?.softCap ?? null,
        hardCap: poolData?.hardCap ?? null,
        totalSellingTokens: poolData?.totalSellingTokens ?? null,
        totalRaised: poolData?.totalRaised ?? null,
        totalCommitted: poolData?.totalCommitted ?? null,
        totalVolumePurchased: poolData?.totalVolumePurchased ?? null,
        startTime: poolData?.startTime ?? null,
        endTime: poolData?.endTime ?? null,
        publicSaleStartTime: poolData?.publicSaleStartTime ?? null,
        finishTime: poolData?.finishTime ?? null,
        claimTime: poolData?.claimTime ?? null,
        liquidityUnlockTime: poolData?.liquidityUnlockTime ?? null,
        liquidityPercentage: poolData?.liquidityPercentage ?? null,
        buybackPercentage: poolData?.buybackPercentage ?? null,
        initialMarketCap: poolData?.initialMarketCap ?? null,
        contributorCount: poolData?.contributorCount ?? null,
        poolLockId: poolData?.poolLockId ?? null,
        poolOwner: poolData?.poolOwner ?? null,
        poolFactory: poolData?.poolFactory ?? null,
        poolRouter: poolData?.poolRouter ?? null,
        poolVersion: poolData?.poolVersion ?? null,
        poolNeedCalculate: poolData?.poolNeedCalculate ?? null,
        calcStage: poolData?.calcStage ?? null,
        calcCurrentIndex: poolData?.calcCurrentIndex ?? null,
        calcFinishedAllocatingUserCount:
          poolData?.calcFinishedAllocatingUserCount ?? null,
        calcDistributableRaised: poolData?.calcDistributableRaised ?? null,
        calcExcessiveAllocations: poolData?.calcExcessiveAllocations ?? null,
        calcTempDistributableRaised:
          poolData?.calcTempDistributableRaised ?? null,
        calcTempExcessiveAllocations:
          poolData?.calcTempExcessiveAllocations ?? null,
        poolDetails: poolData?.poolDetails ?? null,
        kycDetails: poolData?.kycDetails ?? null,
        metadataJson: poolData?.metadataJson ?? null
      });
      results.updatedPools += 1;

      if (strategy === 'dynamic' && needsPostEndRefresh) {
        markPoolPostEndChecked({
          chainId,
          poolAddress: row.pool_address,
          checkedAtSec: nowSec
        });
      }

      if (strategy === 'dynamic') {
        markPoolDynamicChecked({
          chainId,
          poolAddress: row.pool_address,
          checkedAtSec: nowSec
        });
      }
    } catch {
      results.errors += 1;
      if (strategy === 'dynamic') {
        markPoolDynamicChecked({
          chainId,
          poolAddress: row.pool_address,
          checkedAtSec: nowSec
        });
      }
    }

    if (results.evmCandidates % ENRICH_PROGRESS_EVERY === 0) {
      console.log(
        `[enrich-evm] processed=${results.evmCandidates}/${results.scanned} tokenUpdates=${results.updatedTokens} poolUpdates=${results.updatedPools} errors=${results.errors}`
      );
    }
  }

  return results;
}
