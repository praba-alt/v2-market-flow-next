import { callNonEvmRpc } from "../../lib/non-evm-rpc";
import {
  PINKSALE_CHAIN_CONFIG,
  getChainSlug,
  getPinksaleLaunchpadUrl
} from "../../lib/pinksale-chains";

function parsePossiblyWrappedJson(text) {
  if (!text) return null;
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else start = Math.max(firstBrace, firstBracket);

  if (start < 0) return null;
  return JSON.parse(trimmed.slice(start));
}

async function fetchText(url, headers, timeoutMs = 15000) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await fetch(url, {
    method: "GET",
    headers: headers || {},
    cache: "no-store",
    signal
  });
  return {
    ok: res.ok,
    status: res.status,
    text: await res.text()
  };
}

async function fetchJsonTry(url, headers) {
  try {
    const out = await fetchText(url, headers);
    if (!out.ok) return null;
    return parsePossiblyWrappedJson(out.text);
  } catch {
    return null;
  }
}

const EVM_RPC_BY_CHAIN_ID = Object.fromEntries(
  Object.values(PINKSALE_CHAIN_CONFIG)
    .filter((config) => config?.family === "evm")
    .map((config) => [
      config.chainId,
      (config.rpcEnvVar ? process.env[config.rpcEnvVar] : "") || config.defaultRpcUrl || ""
    ])
    .filter(([, rpcUrl]) => Boolean(rpcUrl))
);

const PINKSALE_POOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PINKSALE_POOL_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PINKSALE_LOCKERS_CACHE_TTL_MS = 60 * 60 * 1000;
const PINKSALE_LOCKERS_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const PINKSALE_POOL_CACHE = new Map();
const PINKSALE_POOL_INFLIGHT = new Map();
const PINKSALE_LOCKERS_CACHE = new Map();
const PINKSALE_LOCKERS_INFLIGHT = new Map();

const EVM_PINKLOCK_BY_CHAIN_ID = {
  1: {
    v2: "0x71B5759d73262FBb223956913ecF4ecC51057641",
    v3: "0x29AEd81d274f94CEa037d05Bb61eB93223A48a77"
  },
  25: {
    v2: "0x102137A9F278B013419332f82aCEA429D944Fc34",
    v3: ""
  },
  56: {
    v2: "0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE",
    v3: ""
  },
  97: {
    v2: "0x5E5b9bE5fd939c578ABE5800a90C566eeEbA44a5",
    v3: "0x2529e2747d3C570870aA5931AE26E181a60449DD"
  },
  137: {
    v2: "0x6C9A0D8B1c7a95a323d744dE30cf027694710633",
    v3: ""
  },
  130: {
    v2: "0x37deb4Ed95484d9C3e9A8B513EcB1BeBd5f77944",
    v3: ""
  },
  196: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  250: {
    v2: "0x0E1757b9d6501e60B2e4Ca0D000e49532948CF6c",
    v3: ""
  },
  369: {
    v2: "0x8c32f969b7166088E8e809429C516dCA71AD94F5",
    v3: ""
  },
  1116: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  2000: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  7171: {
    v2: "0xA64bd15cAc500a5e40E93F93088A35DC00fE1851",
    v3: ""
  },
  42161: {
    v2: "0xeBb415084Ce323338CFD3174162964CC23753dFD",
    v3: ""
  },
  8453: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  7000: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  3797: {
    v2: "0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC",
    v3: ""
  },
  43114: {
    v2: "0x9479C6484a392113bB829A15E7c9E033C9e70D30",
    v3: ""
  }
};

const GET_LOCK_BY_ID_SELECTOR = "0x08f12470";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const SOLANA_LOCK_LAYOUT = {
  lockDateOffset: 144,
  unlockDateOffset: 152,
  cycleSecondsOffset: 160,
  tgePercentBpsOffset: 164,
  cycleReleasePercentBpsOffset: 166,
  amountOffset: 168,
  unlockedAmountOffset: 176,
  titleLenOffset: 184,
  titleOffset: 188
};

function toPositiveSafeNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === "bigint") {
    if (v <= 0n) return 0;
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isSupportedEvmChain(chainId) {
  return Boolean(EVM_RPC_BY_CHAIN_ID[Number(chainId)] && EVM_PINKLOCK_BY_CHAIN_ID[Number(chainId)]);
}

function makeBootstrapCacheKey(chainId, id) {
  const rawId = String(id || "").trim();
  const normalizedId = /^0x/i.test(rawId) ? rawId.toLowerCase() : rawId;
  return `${chainId}:${normalizedId}`;
}

function getCacheSnapshot(cache, key, freshTtlMs, staleTtlMs) {
  const entry = cache.get(key);
  if (!entry) {
    return {
      entry: null,
      ageMs: null,
      isFresh: false,
      isStaleUsable: false
    };
  }

  const ageMs = Math.max(0, Date.now() - entry.fetchedAtMs);
  return {
    entry,
    ageMs,
    isFresh: ageMs <= freshTtlMs,
    isStaleUsable: ageMs <= staleTtlMs
  };
}

async function getCachedBootstrapValue({
  cache,
  inflight,
  cacheKey,
  freshTtlMs,
  staleTtlMs,
  fetchLive
}) {
  const cached = getCacheSnapshot(cache, cacheKey, freshTtlMs, staleTtlMs);
  if (cached.isFresh) {
    return {
      ...cached.entry,
      cacheStatus: "fresh",
      cacheAgeMs: cached.ageMs
    };
  }

  let live = null;
  const inflightRequest = inflight.get(cacheKey);
  if (inflightRequest) {
    live = await inflightRequest;
  } else {
    const request = (async () => {
      try {
        return await fetchLive();
      } finally {
        inflight.delete(cacheKey);
      }
    })();
    inflight.set(cacheKey, request);
    live = await request;
  }

  if (live?.value != null) {
    const nextEntry = {
      value: live.value,
      sourceMode: live.sourceMode || "live",
      fetchedAtMs: Date.now()
    };
    cache.set(cacheKey, nextEntry);
    return {
      ...nextEntry,
      cacheStatus: cached.entry ? "refreshed" : "miss",
      cacheAgeMs: 0
    };
  }

  if (cached.entry && cached.isStaleUsable) {
    return {
      ...cached.entry,
      cacheStatus: "stale",
      cacheAgeMs: cached.ageMs
    };
  }

  return null;
}

function getPinklockCycleUnit(chainId) {
  return Number(chainId) === 97 ? "minutes" : "days";
}

function normalizePinklockCycleValue(cycleSeconds, chainId) {
  const seconds = toPositiveSafeNumber(cycleSeconds);
  if (!seconds) return 0;
  return getPinklockCycleUnit(chainId) === "minutes" ? Math.trunc(seconds / 60) : Math.trunc(seconds / 86400);
}

function formatPinklockCycleText(cycleValue, cycleUnit) {
  const value = toPositiveSafeNumber(cycleValue);
  return value > 0 ? `${value} ${cycleUnit}` : "";
}

function choosePinklockAddress(chainId, lockVersion, lockId) {
  const cfg = EVM_PINKLOCK_BY_CHAIN_ID[Number(chainId)];
  if (!cfg) return "";

  const version = Number(lockVersion);
  if (version === 2 && cfg.v2) return cfg.v2;
  if (version === 3 && cfg.v3) return cfg.v3;

  const numericLockId = Number(lockId);
  if (cfg.v3 && Number.isFinite(numericLockId) && numericLockId >= 5000000) return cfg.v3;

  return cfg.v2 || cfg.v3 || "";
}

function hexToBigIntSafe(hex) {
  if (!hex) return 0n;
  const clean = String(hex).replace(/^0x/i, "");
  if (!clean) return 0n;
  return BigInt(`0x${clean}`);
}

function padUint256Hex(value) {
  try {
    return BigInt(value).toString(16).padStart(64, "0");
  } catch {
    return "";
  }
}

function decodeAbiString(cleanHex, headByteOffset, relativeByteOffset) {
  const start = headByteOffset * 2 + relativeByteOffset * 2;
  if (!Number.isFinite(start) || start < 0 || start + 64 > cleanHex.length) return "";

  const len = toPositiveSafeNumber(hexToBigIntSafe(cleanHex.slice(start, start + 64)));
  if (!len) return "";

  const bodyStart = start + 64;
  const bodyEnd = bodyStart + len * 2;
  if (bodyEnd > cleanHex.length) return "";

  return Buffer.from(cleanHex.slice(bodyStart, bodyEnd), "hex").toString("utf8");
}

function extractPinklockTitle(description) {
  const raw = String(description || "").trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
      if (typeof parsed.l === "string" && parsed.l.trim()) return parsed.l.trim();
    }
  } catch {}

  return raw.startsWith("{") || raw.startsWith("[") ? "" : raw;
}

function decodePinklockRecord(resultHex) {
  const clean = String(resultHex || "").replace(/^0x/i, "");
  if (!clean || clean.length < 64) return null;

  const tupleByteOffset = toPositiveSafeNumber(hexToBigIntSafe(clean.slice(0, 64)));
  const headStart = tupleByteOffset * 2;
  if (!headStart || headStart + 11 * 64 > clean.length) return null;

  const readWord = (slot) => clean.slice(headStart + slot * 64, headStart + (slot + 1) * 64);
  const amount = hexToBigIntSafe(readWord(3));
  const lockDate = toPositiveSafeNumber(hexToBigIntSafe(readWord(4)));
  const tgeDate = toPositiveSafeNumber(hexToBigIntSafe(readWord(5)));
  const tgePercentBps = toPositiveSafeNumber(hexToBigIntSafe(readWord(6)));
  const cycle = toPositiveSafeNumber(hexToBigIntSafe(readWord(7)));
  const cycleReleasePercentBps = toPositiveSafeNumber(hexToBigIntSafe(readWord(8)));
  const unlockedAmount = hexToBigIntSafe(readWord(9));
  const descriptionOffset = toPositiveSafeNumber(hexToBigIntSafe(readWord(10)));
  const description = decodeAbiString(clean, tupleByteOffset, descriptionOffset);

  return {
    amount: amount.toString(),
    lockDate,
    tgeDate,
    tgePercentBps,
    cycle,
    cycleReleasePercentBps,
    unlockedAmount: unlockedAmount.toString(),
    description,
    title: extractPinklockTitle(description)
  };
}

async function callEthereumRpc(rpcUrl, method, params, timeoutMs = 15000) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  return res.json();
}

async function fetchEvmTokenSnapshotOnChain(chainId, tokenAddress) {
  const rpcUrl = EVM_RPC_BY_CHAIN_ID[Number(chainId)];
  if (!rpcUrl || !tokenAddress) return null;

  try {
    const [decimalsResult, totalSupplyResult] = await Promise.allSettled([
      callEthereumRpc(
        rpcUrl,
        "eth_call",
        [{ to: tokenAddress, data: ERC20_DECIMALS_SELECTOR }, "latest"],
        10000
      ),
      callEthereumRpc(
        rpcUrl,
        "eth_call",
        [{ to: tokenAddress, data: ERC20_TOTAL_SUPPLY_SELECTOR }, "latest"],
        10000
      )
    ]);

    const decimalsPayload = decimalsResult.status === "fulfilled" ? decimalsResult.value : null;
    const totalSupplyPayload = totalSupplyResult.status === "fulfilled" ? totalSupplyResult.value : null;
    const decimals =
      typeof decimalsPayload?.result === "string"
        ? toPositiveSafeNumber(hexToBigIntSafe(decimalsPayload.result))
        : 0;
    const totalSupply =
      typeof totalSupplyPayload?.result === "string"
        ? hexToBigIntSafe(totalSupplyPayload.result).toString()
        : "";

    if (!decimals && !totalSupply) return null;

    return {
      decimals: decimals || null,
      totalSupply: totalSupply || null,
      source: "rpc"
    };
  } catch {
    return null;
  }
}

async function fetchPinklockRecordOnChain({ chainId, lockId, lockVersion }) {
  const rpcUrl = EVM_RPC_BY_CHAIN_ID[Number(chainId)];
  const pinklockAddress = choosePinklockAddress(chainId, lockVersion, lockId);
  const encodedLockId = padUint256Hex(lockId);
  if (!rpcUrl || !pinklockAddress || !encodedLockId) return null;

  try {
    const payload = await callEthereumRpc(
      rpcUrl,
      "eth_call",
      [
        {
          to: pinklockAddress,
          data: `${GET_LOCK_BY_ID_SELECTOR}${encodedLockId}`
        },
        "latest"
      ],
      10000
    );

    if (!payload || payload.error || typeof payload.result !== "string") return null;
    return decodePinklockRecord(payload.result);
  } catch {
    return null;
  }
}

function decodeSolanaPinklockRecord(base64Data) {
  if (!base64Data) return null;

  let buf;
  try {
    buf = Buffer.from(base64Data, "base64");
  } catch {
    return null;
  }

  if (!buf || buf.length < SOLANA_LOCK_LAYOUT.titleOffset) return null;

  const titleLen = Math.min(
    buf.readUInt32LE(SOLANA_LOCK_LAYOUT.titleLenOffset),
    Math.max(0, buf.length - SOLANA_LOCK_LAYOUT.titleOffset)
  );

  return {
    lockDate: Number(buf.readBigUInt64LE(SOLANA_LOCK_LAYOUT.lockDateOffset)),
    unlockDate: Number(buf.readBigUInt64LE(SOLANA_LOCK_LAYOUT.unlockDateOffset)),
    cycleSeconds: buf.readUInt32LE(SOLANA_LOCK_LAYOUT.cycleSecondsOffset),
    tgePercentBps: buf.readUInt16LE(SOLANA_LOCK_LAYOUT.tgePercentBpsOffset),
    cycleReleasePercentBps: buf.readUInt16LE(SOLANA_LOCK_LAYOUT.cycleReleasePercentBpsOffset),
    amount: buf.readBigUInt64LE(SOLANA_LOCK_LAYOUT.amountOffset).toString(),
    unlockedAmount: buf.readBigUInt64LE(SOLANA_LOCK_LAYOUT.unlockedAmountOffset).toString(),
    title: Buffer.from(
      buf.slice(SOLANA_LOCK_LAYOUT.titleOffset, SOLANA_LOCK_LAYOUT.titleOffset + titleLen)
    )
      .toString("utf8")
      .replace(/\0+$/, "")
      .trimEnd()
  };
}

async function fetchSolanaPinklockRecord(lockerPubkey) {
  if (!lockerPubkey) return null;

  try {
    const payload = await callNonEvmRpc(
      "solana",
      "getAccountInfo",
      [lockerPubkey, { encoding: "base64" }],
      10000
    );
    const base64Data = payload?.result?.value?.data?.[0];
    if (typeof base64Data !== "string") return null;
    return decodeSolanaPinklockRecord(base64Data);
  } catch {
    return null;
  }
}

async function fetchSolanaMintSnapshotOnChain(mintAddress) {
  if (!mintAddress) return null;

  try {
    const payload = await callNonEvmRpc("solana", "getTokenSupply", [mintAddress], 10000);
    const amount = payload?.result?.value?.amount;
    const decimals = payload?.result?.value?.decimals;

    if (typeof amount !== "string" && typeof decimals !== "number") return null;

    return {
      decimals: typeof decimals === "number" ? decimals : null,
      totalSupply: typeof amount === "string" ? amount : null,
      source: "rpc"
    };
  } catch {
    return null;
  }
}

function toBigIntSafe(v) {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return 0n;
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

function pct6(value, total) {
  if (total <= 0n) return 0;
  const scaled = (value * 100000000n) / total; // 100 * 1e6
  return Number(scaled) / 1000000;
}

function pow10(n) {
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= 10n;
  return out;
}

function parseCycleDays(text) {
  if (!text) return 0;
  const dayMatch = String(text).match(/(\d+)\s*days?/i);
  if (dayMatch) return Number(dayMatch[1]);
  const m = String(text).match(/cycle(?:\s*\(d\))?\s*[:=-]?\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isGenericLockTitle(title, lockId, isLiquidity = false) {
  const normalized = String(title || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === String(`Lock ${lockId}`).toLowerCase()) return true;
  if (!isLiquidity && normalized === "liquidity lock") return true;
  if (!isLiquidity && normalized === "liquidity lock.") return true;
  return false;
}

function getFallbackLockTitle({ lockId, isLiquidity, title }) {
  const normalized = String(title || "").trim().toLowerCase();
  if (isLiquidity || normalized === "liquidity lock" || normalized === "liquidity lock.") {
    return "Manual Liquidity Lock";
  }
  return `Lock ${lockId}`;
}

function resolveLockerDocTitle(doc, lockId) {
  const parsedDescriptionTitle = extractPinklockTitle(doc?.description);
  const parsedDescTitle = extractPinklockTitle(doc?.desc);
  const title = firstNonEmptyString(
    doc?.solana_details?.locker_title,
    doc?.locker_title,
    doc?.title,
    doc?.name,
    parsedDescriptionTitle,
    parsedDescTitle
  );

  if (title) return title;
  return doc?.is_liquidity ? "Liquidity Lock" : `Lock ${lockId}`;
}

function makeLockCandidateKey(candidate) {
  const chainId = String(candidate?.chainId || "");
  const lockId = String(candidate?.lockId || "").trim().toLowerCase();
  const lockerPubkey = String(candidate?.lockerPubkey || "").trim().toLowerCase();
  const base = lockerPubkey || lockId;
  return base ? `${chainId}:${base}` : "";
}

function mergeLockCandidate(baseCandidate, nextCandidate) {
  return {
    ...baseCandidate,
    ...nextCandidate,
    doc: nextCandidate?.doc || baseCandidate?.doc || null,
    title: firstNonEmptyString(nextCandidate?.title, baseCandidate?.title),
    sourceTypes: [
      ...new Set([...(baseCandidate?.sourceTypes || []), ...(nextCandidate?.sourceTypes || [])])
    ]
  };
}

function upsertLockCandidate(map, candidate) {
  const key = makeLockCandidateKey(candidate);
  if (!key) return;
  const existing = map.get(key);
  map.set(key, existing ? mergeLockCandidate(existing, candidate) : candidate);
}

function buildLockCandidates({ pageProps, chainId, lockerDocs }) {
  const candidates = new Map();
  const resolvedChainId = Number(chainId);
  const pool = pageProps?.pool?.pool || {};
  const risk = pageProps?.pool?.riskDetails || {};

  const poolLocker = firstNonEmptyString(pool?.locker);
  if (resolvedChainId === 501424 && poolLocker) {
    upsertLockCandidate(candidates, {
      chainId: resolvedChainId,
      lockId: poolLocker,
      lockerPubkey: poolLocker,
      isLiquidity: Boolean(
        toPositiveSafeNumber(pool?.liquidityLockDuration) > 0 ||
          toPositiveSafeNumber(risk?.lpLockDays) > 0
      ),
      title: "",
      doc: null,
      sourceTypes: ["pool-info"]
    });
  }

  for (const doc of lockerDocs || []) {
    const lockId = String(doc?.lock_id || "").trim();
    const lockerPubkey = firstNonEmptyString(doc?.solana_details?.locker_pubkey);
    if (!lockId && !lockerPubkey) continue;

    upsertLockCandidate(candidates, {
      chainId: Number(doc?.chain_id || resolvedChainId),
      lockId: lockId || lockerPubkey,
      lockerPubkey,
      isLiquidity: Boolean(doc?.is_liquidity),
      title: resolveLockerDocTitle(doc, lockId || lockerPubkey),
      doc,
      sourceTypes: ["lockers-api"]
    });
  }

  return [...candidates.values()];
}

function hasResolvedLockRecord(record) {
  if (!record) return false;
  return (
    toBigIntSafe(record.amount) > 0n ||
    toBigIntSafe(record.unlockedAmount) > 0n ||
    toBigIntSafe(record.currentLockedAmount) > 0n ||
    toPositiveSafeNumber(record.lockDate) > 0 ||
    toPositiveSafeNumber(record.expiredAt) > 0 ||
    toPositiveSafeNumber(record.tgePercentBps) > 0 ||
    toPositiveSafeNumber(record.cycleReleasePercentBps) > 0 ||
    toPositiveSafeNumber(record.cycleValue) > 0
  );
}

function getRecordCycleValue(rec) {
  return toPositiveSafeNumber(rec?.cycleValue ?? rec?.cycleDays ?? 0);
}

function getAllocationLabel(title, status) {
  const clean = String(title || "").trim();
  if (!clean) return status === "locked" ? "Locked Allocation" : "Unlocked Allocation";
  return `${clean} (${status === "locked" ? "Locked" : "Unlocked"})`;
}

function percentFromBps(bps) {
  const value = toPositiveSafeNumber(bps);
  return value > 0 ? value / 100 : 0;
}

function fitEntriesToAmount(entries, targetAmount) {
  const target = toBigIntSafe(targetAmount);
  if (target <= 0n) {
    return entries.map((entry) => ({ ...entry, amount: 0n }));
  }

  const total = entries.reduce((acc, entry) => acc + toBigIntSafe(entry?.amount), 0n);
  if (total <= target) return entries;

  let remaining = target;
  return entries.map((entry, index) => {
    const amount = toBigIntSafe(entry?.amount);
    if (index === entries.length - 1) {
      return { ...entry, amount: remaining };
    }

    const scaled = (amount * target) / total;
    const nextAmount = scaled > remaining ? remaining : scaled;
    remaining -= nextAmount;
    return { ...entry, amount: nextAmount };
  });
}

function getLiquidityLockBaseTime(sale) {
  const finishTime = toPositiveSafeNumber(sale?.finishTime);
  if (finishTime > 0) {
    return { baseTime: finishTime, isEstimated: false };
  }

  const endTime = toPositiveSafeNumber(sale?.endTime);
  if (endTime > 0) {
    return { baseTime: endTime, isEstimated: true };
  }

  const claimTime = toPositiveSafeNumber(sale?.claimTime);
  if (claimTime > 0) {
    return { baseTime: claimTime, isEstimated: true };
  }

  return { baseTime: 0, isEstimated: true };
}

function buildLiquidityLockRecords({ sale, risk, tokensForLiquidity }) {
  const amount = toBigIntSafe(tokensForLiquidity);
  const lockDurationSeconds = toPositiveSafeNumber(sale?.liquidityLockDuration);
  if (amount <= 0n || !lockDurationSeconds || Boolean(risk?.isLpBurned)) {
    return [];
  }

  const { baseTime, isEstimated } = getLiquidityLockBaseTime(sale);
  const expiredAt = baseTime > 0 ? baseTime + lockDurationSeconds : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const isCurrentlyLocked = expiredAt <= 0 || expiredAt > nowSec;

  return [
    {
      lockId: "liquidity-auto",
      title: "Auto Listing Liquidity",
      amount: amount.toString(),
      unlockedAmount: isCurrentlyLocked ? "0" : amount.toString(),
      currentLockedAmount: isCurrentlyLocked ? amount.toString() : "0",
      lockDate: baseTime,
      expiredAt,
      lockDurationSeconds,
      isEstimatedUnlockTime: isEstimated,
      isLiquidity: true,
      isAutoLiquidityLock: true
    }
  ];
}

function mergeOnChainTokenSnapshot(pageProps, tokenSnapshot) {
  if (!pageProps?.pool || !tokenSnapshot) return pageProps;

  const nextPool = {
    ...pageProps.pool,
    token: {
      ...(pageProps.pool.token || {})
    },
    riskDetails: {
      ...(pageProps.pool.riskDetails || {})
    }
  };

  if (tokenSnapshot.decimals != null) {
    nextPool.token.decimals = tokenSnapshot.decimals;
  }

  if (tokenSnapshot.totalSupply) {
    nextPool.token.totalSupply = tokenSnapshot.totalSupply;
    nextPool.riskDetails.totalSupply = tokenSnapshot.totalSupply;
  }

  return {
    ...pageProps,
    pool: nextPool
  };
}

async function fetchPinksalePoolBootstrap({ cacheKey, fullInfoUrl, fullInfoProxyUrl }) {
  return getCachedBootstrapValue({
    cache: PINKSALE_POOL_CACHE,
    inflight: PINKSALE_POOL_INFLIGHT,
    cacheKey,
    freshTtlMs: PINKSALE_POOL_CACHE_TTL_MS,
    staleTtlMs: PINKSALE_POOL_STALE_TTL_MS,
    fetchLive: async () => {
      try {
        const direct = await fetchText(fullInfoUrl, {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
        });
        if (direct.ok) {
          const json = parsePossiblyWrappedJson(direct.text);
          if (json && typeof json === "object") {
            return {
              value: { pool: json },
              sourceMode: "api-direct"
            };
          }
        }
      } catch {}

      try {
        const proxiedApi = await fetchText(fullInfoProxyUrl, {
          Accept: "text/plain"
        });
        if (proxiedApi.ok) {
          const json = parsePossiblyWrappedJson(proxiedApi.text);
          if (json && typeof json === "object") {
            return {
              value: { pool: json },
              sourceMode: "api-proxied"
            };
          }
        }
      } catch {}

      return null;
    }
  });
}

async function fetchPinksaleLockersBootstrap({ cacheKey, lockersUrl, lockersProxyUrl }) {
  return getCachedBootstrapValue({
    cache: PINKSALE_LOCKERS_CACHE,
    inflight: PINKSALE_LOCKERS_INFLIGHT,
    cacheKey,
    freshTtlMs: PINKSALE_LOCKERS_CACHE_TTL_MS,
    staleTtlMs: PINKSALE_LOCKERS_STALE_TTL_MS,
    fetchLive: async () => {
      const direct = await fetchJsonTry(lockersUrl, { Accept: "application/json" });
      if (direct && typeof direct === "object") {
        return {
          value: direct,
          sourceMode: "api-direct"
        };
      }

      const proxied = await fetchJsonTry(lockersProxyUrl, { Accept: "text/plain" });
      if (proxied && typeof proxied === "object") {
        return {
          value: proxied,
          sourceMode: "api-proxied"
        };
      }

      return null;
    }
  });
}

function mapTokenomicsWithLockRecords(pageProps, lockRecords) {
  const full = pageProps?.pool || {};
  const token = full?.token || {};
  const currency = full?.currency || {};
  const sale = full?.pool || {};
  const risk = full?.riskDetails || {};

  const totalSupply = toBigIntSafe(risk.totalSupply || token.totalSupply);
  const tokensForLiquidity = toBigIntSafe(risk.tokensForLiquidity);
  const totalUnlock = toBigIntSafe(risk.totalUnlock);
  const totalBurned = toBigIntSafe(risk.totalBurned);
  const riskLocked = toBigIntSafe(risk.totalLocked);

  const vestingRecords = [];
  const lockedRecords = [];
  const unlockedAllocationEntries = [];
  for (const rec of lockRecords || []) {
    const lockedAmount = toBigIntSafe(rec.currentLockedAmount || 0);
    const unlockedAmount = toBigIntSafe(rec.unlockedAmount || 0);

    if (lockedAmount > 0n) {
      if (getRecordCycleValue(rec) > 0) {
        vestingRecords.push({ ...rec, amount: lockedAmount });
      } else {
        lockedRecords.push({ ...rec, amount: lockedAmount });
      }
    }

    if (unlockedAmount > 0n) {
      unlockedAllocationEntries.push({
        title: rec?.title,
        amount: unlockedAmount
      });
    }
  }

  const totalVesting = vestingRecords.reduce((acc, r) => acc + r.amount, 0n);
  const totalLockedFromRecords = lockedRecords.reduce((acc, r) => acc + r.amount, 0n);
  const explainedLocked = totalLockedFromRecords + totalVesting;
  const totalLockedOverall = riskLocked > explainedLocked ? riskLocked : explainedLocked;
  const remainingLocked = totalLockedOverall > explainedLocked ? totalLockedOverall - explainedLocked : 0n;
  const totalLocked = totalLockedFromRecords + remainingLocked;

  let tokensForPresale = 0n;
  const hardCap = toBigIntSafe(sale.hardCap);
  const presaleRate = toBigIntSafe(sale.rate);
  const totalSellingTokens = toBigIntSafe(sale.totalSellingTokens);
  const currencyDecimals =
    typeof currency.decimals === "number" ? currency.decimals : Number(currency.decimals || 18);
  if (totalSellingTokens > 0n) {
    tokensForPresale = totalSellingTokens;
  } else if (hardCap > 0n && presaleRate > 0n) {
    tokensForPresale = (hardCap * presaleRate) / pow10(currencyDecimals);
  } else {
    tokensForPresale =
      totalSupply - tokensForLiquidity - totalUnlock - totalBurned - totalLocked - totalVesting;
    if (tokensForPresale < 0n) tokensForPresale = 0n;
  }

  let computedUnlocked =
    totalSupply - tokensForPresale - tokensForLiquidity - totalBurned - totalLocked - totalVesting;
  if (computedUnlocked < 0n) computedUnlocked = 0n;

  const tokensForPresalePercent = pct6(tokensForPresale, totalSupply);
  const tokensForLiquidityPercent = pct6(tokensForLiquidity, totalSupply);
  const unlockedPercent = pct6(computedUnlocked, totalSupply);
  const burntPercent = pct6(totalBurned, totalSupply);
  const lockedPercent = pct6(totalLocked, totalSupply);
  const antirugPercent = pct6(totalVesting, totalSupply);

  const lockedAllocationGroups = new Map();
  for (const r of vestingRecords) {
    const key = getAllocationLabel(r.title, "locked");
    lockedAllocationGroups.set(key, (lockedAllocationGroups.get(key) || 0n) + r.amount);
  }
  for (const r of lockedRecords) {
    const key = getAllocationLabel(r.title, "locked");
    lockedAllocationGroups.set(key, (lockedAllocationGroups.get(key) || 0n) + r.amount);
  }
  if (remainingLocked > 0n) {
    lockedAllocationGroups.set(
      "Locked Allocation",
      (lockedAllocationGroups.get("Locked Allocation") || 0n) + remainingLocked
    );
  }

  const normalizedUnlockedEntries = fitEntriesToAmount(unlockedAllocationEntries, computedUnlocked);
  const unlockedAllocationGroups = new Map();
  let explainedUnlocked = 0n;
  for (const entry of normalizedUnlockedEntries) {
    const amount = toBigIntSafe(entry?.amount);
    if (amount <= 0n) continue;
    const key = getAllocationLabel(entry?.title, "unlocked");
    unlockedAllocationGroups.set(key, (unlockedAllocationGroups.get(key) || 0n) + amount);
    explainedUnlocked += amount;
  }

  const residualUnlocked = computedUnlocked > explainedUnlocked ? computedUnlocked - explainedUnlocked : 0n;

  const chartSegments = [];
  if (tokensForPresale > 0n) {
    chartSegments.push({
      label: "Presale",
      amount: tokensForPresale.toString(),
      percent: tokensForPresalePercent
    });
  }
  if (tokensForLiquidity > 0n) {
    chartSegments.push({
      label: "Liquidity",
      amount: tokensForLiquidity.toString(),
      percent: tokensForLiquidityPercent
    });
  }
  for (const [label, amount] of lockedAllocationGroups.entries()) {
    const p = pct6(amount, totalSupply);
    if (p <= 0) continue;
    chartSegments.push({
      label,
      amount: amount.toString(),
      percent: p
    });
  }
  for (const [label, amount] of unlockedAllocationGroups.entries()) {
    const p = pct6(amount, totalSupply);
    if (p <= 0) continue;
    chartSegments.push({
      label,
      amount: amount.toString(),
      percent: p
    });
  }
  if (residualUnlocked > 0n) {
    chartSegments.push({
      label: "Unlocked",
      amount: residualUnlocked.toString(),
      percent: pct6(residualUnlocked, totalSupply)
    });
  }
  if (totalBurned > 0n) {
    chartSegments.push({
      label: "Burnt",
      amount: totalBurned.toString(),
      percent: burntPercent
    });
  }

  const liquidityLockRecords = buildLiquidityLockRecords({
    sale,
    risk,
    tokensForLiquidity
  });

  return {
    totalSupply: totalSupply.toString(),
    tokensForPresale: tokensForPresale.toString(),
    tokensForLiquidity: tokensForLiquidity.toString(),
    totalUnlock: computedUnlocked.toString(),
    totalBurned: totalBurned.toString(),
    totalLocked: totalLocked.toString(),
    totalVesting: totalVesting.toString(),
    tokensForPresalePercent,
    tokensForLiquidityPercent,
    unlockedPercent,
    burntPercent,
    lockedPercent,
    antirugPercent,
    chartSegments,
    liquidityLockRecords,
    vestingRecords: vestingRecords.map((r) => ({
      lockId: r.lockId,
      title: r.title,
      amount: r.amount.toString(),
      cycleValue: getRecordCycleValue(r),
      cycleUnit: r.cycleUnit || "days",
      cycleText: r.cycleText || "",
      cycleDays: r.cycleDays
    })),
    lockRecords: lockedRecords.map((r) => ({
      lockId: r.lockId,
      title: r.title,
      amount: r.amount.toString(),
      cycleValue: getRecordCycleValue(r),
      cycleUnit: r.cycleUnit || "days",
      cycleText: r.cycleText || "",
      cycleDays: r.cycleDays
    }))
  };
}

export default async function handler(req, res) {
  const requestedChainId = Number(req.query.chainId || "56");
  const resolvedChainId = Number.isFinite(requestedChainId) ? requestedChainId : 56;
  const chainId = String(resolvedChainId);
  const chain = String(getChainSlug(resolvedChainId) || req.query.chain || "bsc");
  const poolAddress = String(
    req.query.poolAddress || "0x35C79c669a44dAC0c07Cee032b7ab84e3368F359"
  );
  const target = getPinksaleLaunchpadUrl(resolvedChainId, poolAddress);
  const fullInfoUrl = `https://api.pinksale.finance/api/v1/pool/full_info?chainId=${chainId}&poolAddress=${poolAddress}`;
  const fullInfoProxyUrl = `https://r.jina.ai/http://api.pinksale.finance/api/v1/pool/full_info?chainId=${chainId}&poolAddress=${poolAddress}`;
  const poolCacheKey = makeBootstrapCacheKey(chainId, poolAddress);

  try {
    const poolBootstrap = await fetchPinksalePoolBootstrap({
      cacheKey: poolCacheKey,
      fullInfoUrl,
      fullInfoProxyUrl
    });

    if (!poolBootstrap?.value) {
      res.status(502).json({
        error: "Failed to fetch/parse PinkSale live data",
        target,
        attempted: [fullInfoUrl, fullInfoProxyUrl]
      });
      return;
    }

    let pageProps = poolBootstrap.value;
    const tokenAddress = pageProps?.pool?.token?.address || pageProps?.token?.address;

    let onChainToken = null;
    if (tokenAddress) {
      if (EVM_RPC_BY_CHAIN_ID[resolvedChainId]) {
        onChainToken = await fetchEvmTokenSnapshotOnChain(resolvedChainId, tokenAddress);
      } else if (resolvedChainId === 501424) {
        onChainToken = await fetchSolanaMintSnapshotOnChain(tokenAddress);
      }
    }
    if (onChainToken) {
      pageProps = mergeOnChainTokenSnapshot(pageProps, onChainToken);
    }

    let lockersBootstrap = null;
    if (tokenAddress) {
      const lockersUrl = `https://api.pinksale.finance/api/v1/lockers?chain_id=${chainId}&token=${tokenAddress}&limit=100&page=1&sortType=desc`;
      const lockersProxyUrl = `https://r.jina.ai/http://api.pinksale.finance/api/v1/lockers?chain_id=${chainId}&token=${tokenAddress}&limit=100&page=1&sortType=desc`;
      lockersBootstrap = await fetchPinksaleLockersBootstrap({
        cacheKey: makeBootstrapCacheKey(chainId, tokenAddress),
        lockersUrl,
        lockersProxyUrl
      });
    }

    const lockerDocs = Array.isArray(lockersBootstrap?.value?.docs)
      ? lockersBootstrap.value.docs
      : [];
    const lockCandidates = buildLockCandidates({
      pageProps,
      chainId,
      lockerDocs
    });

    const lockRecords = (
      await Promise.all(
        lockCandidates.map(async (candidate) => {
          const doc = candidate?.doc || null;
          const lockId = String(candidate?.lockId || "").trim();
          const lockerPubkey = firstNonEmptyString(candidate?.lockerPubkey);
          const apiAmount = toBigIntSafe(doc?.amount);
          const apiUnlocked = toBigIntSafe(doc?.unlocked_amount);
          const apiCurrentLockedAmount = apiAmount > apiUnlocked ? apiAmount - apiUnlocked : 0n;
          const resolvedChainId = Number(candidate?.chainId || doc?.chain_id || chainId);
          let title = firstNonEmptyString(candidate?.title) || resolveLockerDocTitle(doc, lockId);
          let cycleValue = parseCycleDays(title);
          let cycleUnit = "days";
          let cycleSeconds = 0;
          let lockDate = toPositiveSafeNumber(doc?.lock_date);
          let expiredAt = toPositiveSafeNumber(doc?.expired);
          let tgePercentBps = 0;
          let cycleReleasePercentBps = 0;
          let amount = apiAmount;
          let unlocked = apiUnlocked;
          let currentLockedAmount = apiCurrentLockedAmount;

          if (isSupportedEvmChain(resolvedChainId) && lockId) {
            const record = await fetchPinklockRecordOnChain({
              chainId: resolvedChainId,
              lockId,
              lockVersion: doc?.lock_version
            });
            if (record) {
              title = record.title || title;
              amount = toBigIntSafe(record.amount) || amount;
              unlocked = toBigIntSafe(record.unlockedAmount);
              currentLockedAmount = amount > unlocked ? amount - unlocked : 0n;
              cycleSeconds = record.cycle || 0;
              cycleUnit = getPinklockCycleUnit(resolvedChainId);
              cycleValue = normalizePinklockCycleValue(cycleSeconds, resolvedChainId);
              lockDate = record.lockDate || lockDate;
              expiredAt = record.tgeDate || expiredAt;
              tgePercentBps = record.tgePercentBps || 0;
              cycleReleasePercentBps = record.cycleReleasePercentBps || 0;
            }
          } else if (resolvedChainId === 501424 && lockerPubkey) {
            const record = await fetchSolanaPinklockRecord(lockerPubkey);
            if (record) {
              title = record.title || title;
              amount = toBigIntSafe(record.amount) || amount;
              unlocked = toBigIntSafe(record.unlockedAmount);
              currentLockedAmount = amount > unlocked ? amount - unlocked : 0n;
              cycleSeconds = record.cycleSeconds || 0;
              cycleUnit = "days";
              cycleValue = normalizePinklockCycleValue(cycleSeconds, resolvedChainId);
              lockDate = record.lockDate || lockDate;
              expiredAt = record.unlockDate || expiredAt;
              tgePercentBps = record.tgePercentBps || 0;
              cycleReleasePercentBps = record.cycleReleasePercentBps || 0;
            }
          }

          if (isGenericLockTitle(title, lockId, Boolean(candidate?.isLiquidity))) {
            title = getFallbackLockTitle({
              lockId,
              isLiquidity: Boolean(candidate?.isLiquidity),
              title
            });
          }

          const cycleText = formatPinklockCycleText(cycleValue, cycleUnit);
          const record = {
            lockId,
            title,
            cycleValue,
            cycleSeconds,
            cycleUnit,
            cycleText,
            cycleDays: cycleUnit === "days" ? cycleValue : 0,
            lockDate,
            expiredAt,
            isLiquidity: Boolean(candidate?.isLiquidity),
            isUnlocked: currentLockedAmount <= 0n,
            tgePercentBps,
            tgePercent: percentFromBps(tgePercentBps),
            cycleReleasePercentBps,
            cycleReleasePercent: percentFromBps(cycleReleasePercentBps),
            amount: amount.toString(),
            unlockedAmount: unlocked.toString(),
            currentLockedAmount: currentLockedAmount.toString()
          };

          return hasResolvedLockRecord(record) ? record : null;
        })
      )
    ).filter(Boolean);

    const mapped = mapTokenomicsWithLockRecords(pageProps, lockRecords);

    res.status(200).json({
      source: {
        url: target,
        fetchedAt: new Date(poolBootstrap.fetchedAtMs || Date.now()).toISOString(),
        servedAt: new Date().toISOString(),
        mode: poolBootstrap.sourceMode,
        cacheStatus: poolBootstrap.cacheStatus,
        cacheAgeMs: poolBootstrap.cacheAgeMs,
        lockersMode: lockersBootstrap?.sourceMode || null,
        lockersCacheStatus: lockersBootstrap?.cacheStatus || null,
        lockersCacheAgeMs: lockersBootstrap?.cacheAgeMs ?? null,
        onChainTokenSource: onChainToken?.source || null
      },
      chain,
      poolAddress,
      token: {
        address: tokenAddress || null,
        symbol: pageProps?.pool?.token?.symbol || null,
        name: pageProps?.pool?.token?.name || null,
        decimals: pageProps?.pool?.token?.decimals ?? null
      },
      mappedTokenomics: mapped,
      rawRiskDetails: pageProps?.pool?.riskDetails || null,
      lockRecords
    });
  } catch (err) {
    res.status(500).json({
      error: err && err.message ? err.message : String(err),
      target
    });
  }
}
