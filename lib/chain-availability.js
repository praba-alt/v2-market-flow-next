// Chains currently treated as unavailable for frontend display and enrichment jobs.
// These are based on repeated RPC probe failures in this workspace.
export const TEMP_UNAVAILABLE_CHAIN_IDS = [250, 109, 7171];

// Enrichment allowlist: only these chains are processed by cron enrich jobs by default.
// You can override this with ENRICH_ENABLED_CHAIN_IDS (comma-separated IDs).
const DEFAULT_ENRICH_ENABLED_CHAIN_IDS = [
  1, // Ethereum
  25, // Cronos
  56, // BNB
  130, // Unichain
  137, // Polygon
  196, // X Layer
  369, // PulseChain
  42161, // Arbitrum
  43114, // Avalanche
  8453, // Base
  50104, // Sui
  501424 // Solana
];

const UNAVAILABLE_SET = new Set(TEMP_UNAVAILABLE_CHAIN_IDS.map((id) => Number(id)));
const DEFAULT_ENRICH_ENABLED_SET = new Set(
  DEFAULT_ENRICH_ENABLED_CHAIN_IDS.map((id) => Number(id))
);

export function isTemporarilyUnavailableChain(chainId) {
  const id = Number(chainId);
  return Number.isFinite(id) && UNAVAILABLE_SET.has(id);
}

export function filterOutTemporarilyUnavailableChainIds(chainIds = []) {
  if (!Array.isArray(chainIds)) return [];
  return chainIds.filter((id) => !isTemporarilyUnavailableChain(id));
}

function parseEnabledChainIdsFromEnv() {
  const raw = String(process.env.ENRICH_ENABLED_CHAIN_IDS || '').trim();
  if (!raw) return null;

  const ids = raw
    .split(',')
    .map((part) => Number(String(part).trim()))
    .filter((id) => Number.isFinite(id));

  if (!ids.length) return null;
  return new Set(ids);
}

export function getEnrichEnabledChainIdSet() {
  const fromEnv = parseEnabledChainIdsFromEnv();
  return fromEnv || DEFAULT_ENRICH_ENABLED_SET;
}

export function isChainEnabledForEnrich(chainId) {
  const id = Number(chainId);
  if (!Number.isFinite(id)) return false;
  return getEnrichEnabledChainIdSet().has(id);
}

// Conservative per-chain delays for enrichment RPC calls (milliseconds).
// Values are intentionally cautious and can be tuned with env vars.
const PER_CHAIN_ENRICH_DELAY_MS = {
  1: 180,
  25: 220,
  56: 180,
  130: 220,
  137: 180,
  196: 220,
  369: 250,
  1116: 260,
  2000: 260,
  3797: 300,
  7000: 350,
  8453: 170,
  42161: 170,
  43114: 220
};

const PER_CHAIN_CREATED_TIME_DELAY_MS = {
  1: 220,
  56: 220,
  137: 220,
  250: 300,
  42161: 220,
  8453: 220,
  43114: 260
};

function getNumberEnv(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function getEvmEnrichDelayMs(chainId, fallbackDelayMs) {
  const id = Number(chainId);
  const fromEnv = getNumberEnv(`EVM_ENRICH_DELAY_MS_${id}`);
  if (fromEnv != null) return fromEnv;
  return PER_CHAIN_ENRICH_DELAY_MS[id] ?? fallbackDelayMs;
}

export function getCreatedTimeDelayMs(chainId, fallbackDelayMs) {
  const id = Number(chainId);
  const fromEnv = getNumberEnv(`CREATED_TIME_DELAY_MS_${id}`);
  if (fromEnv != null) return fromEnv;
  return PER_CHAIN_CREATED_TIME_DELAY_MS[id] ?? fallbackDelayMs;
}
