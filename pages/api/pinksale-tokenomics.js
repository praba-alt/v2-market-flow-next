function parseNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start < 0) return null;

  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end < 0) return null;

  const raw = html.slice(jsonStart, end).trim();
  return JSON.parse(raw);
}

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

const EVM_RPC_BY_CHAIN_ID = {
  1: process.env.ETHEREUM_RPC_URL || "https://ethereum.publicnode.com",
  56: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/",
  97: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/",
  137: process.env.POLYGON_RPC_URL || "https://polygon-bor.publicnode.com",
  42161: process.env.ARBITRUM_RPC_URL || "https://arbitrum-one.publicnode.com",
  8453: process.env.BASE_RPC_URL || "https://base.publicnode.com",
  7000: process.env.ZETACHAIN_RPC_URL || "https://zetachain-evm.blockpi.network/v1/rpc/public",
  3797: process.env.ALVEY_RPC_URL || "https://rpc.alvey.io"
};

const EVM_PINKLOCK_BY_CHAIN_ID = {
  1: {
    v2: "0x71B5759d73262FBb223956913ecF4ecC51057641",
    v3: "0x29AEd81d274f94CEa037d05Bb61eB93223A48a77"
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
    v2: "0x37deb4Ed95484d9C3e9A8B513EcB1BeBd5f77944",
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
  }
};

const GET_LOCK_BY_ID_SELECTOR = "0x08f12470";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://node-solana.pinksale.com/";
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
  const cycle = toPositiveSafeNumber(hexToBigIntSafe(readWord(7)));
  const descriptionOffset = toPositiveSafeNumber(hexToBigIntSafe(readWord(10)));
  const description = decodeAbiString(clean, tupleByteOffset, descriptionOffset);

  return {
    cycle,
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

async function callSolanaRpc(method, params, timeoutMs = 15000) {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const res = await fetch(SOLANA_RPC_URL, {
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
    const payload = await callSolanaRpc(
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
  const m = String(text).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
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
  const chain = String(req.query.chain || "bsc");
  const chainId = String(req.query.chainId || "56");
  const poolAddress = String(
    req.query.poolAddress || "0x35C79c669a44dAC0c07Cee032b7ab84e3368F359"
  );
  const isSolana = String(chain).toLowerCase() === "solana" || String(chainId) === "501424";
  const target = isSolana
    ? `https://www.pinksale.finance/solana/launchpad/${poolAddress}`
    : `https://www.pinksale.finance/launchpad/${chain}/${poolAddress}`;
  const fullInfoUrl = `https://api.pinksale.finance/api/v1/pool/full_info?chainId=${chainId}&poolAddress=${poolAddress}`;
  const fullInfoProxyUrl = `https://r.jina.ai/http://api.pinksale.finance/api/v1/pool/full_info?chainId=${chainId}&poolAddress=${poolAddress}`;
  const targetProxy = isSolana
    ? `https://r.jina.ai/http://www.pinksale.finance/solana/launchpad/${poolAddress}`
    : `https://r.jina.ai/http://www.pinksale.finance/launchpad/${chain}/${poolAddress}`;

  try {
    let pageProps = null;
    let sourceMode = "";

    // 1) Preferred: direct full_info (often blocked by Cloudflare)
    try {
      const direct = await fetchText(fullInfoUrl, {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
      });
      if (direct.ok) {
        const json = parsePossiblyWrappedJson(direct.text);
        if (json && typeof json === "object") {
          pageProps = { pool: json };
          sourceMode = "api-direct";
        }
      }
    } catch {}

    // 2) Fallback: proxied full_info via r.jina.ai
    if (!pageProps) {
      try {
        const proxiedApi = await fetchText(fullInfoProxyUrl, {
          Accept: "text/plain"
        });
        if (proxiedApi.ok) {
          const json = parsePossiblyWrappedJson(proxiedApi.text);
          if (json && typeof json === "object") {
            pageProps = { pool: json };
            sourceMode = "api-proxied";
          }
        }
      } catch {}
    }

    // 3) Last fallback: launchpad HTML -> __NEXT_DATA__ (proxied)
    if (!pageProps) {
      try {
        const upstream = await fetchText(targetProxy, {
          Accept: "text/plain"
        });
        if (upstream.ok) {
          const nextData = parseNextData(upstream.text);
          if (nextData?.props?.pageProps) {
            pageProps = nextData.props.pageProps;
            sourceMode = "page-proxied";
          }
        }
      } catch {}
    }

    if (!pageProps) {
      res.status(502).json({
        error: "Failed to fetch/parse PinkSale live data",
        target,
        attempted: [fullInfoUrl, fullInfoProxyUrl, targetProxy]
      });
      return;
    }

    const tokenAddress = pageProps?.pool?.token?.address || pageProps?.token?.address;

    let lockers = null;
    if (tokenAddress) {
      const lockersUrl = `https://api.pinksale.finance/api/v1/lockers?chain_id=${chainId}&token=${tokenAddress}&limit=100&page=1&sortType=desc`;
      const lockersProxyUrl = `https://r.jina.ai/http://api.pinksale.finance/api/v1/lockers?chain_id=${chainId}&token=${tokenAddress}&limit=100&page=1&sortType=desc`;
      lockers =
        (await fetchJsonTry(lockersUrl, { Accept: "application/json" })) ||
        (await fetchJsonTry(lockersProxyUrl, { Accept: "text/plain" }));
    }

    const lockerDocs = Array.isArray(lockers?.docs) ? lockers.docs : [];
    const lockableDocs = lockerDocs
      .map((doc) => {
        const lockId = String(doc?.lock_id || "");
        const amount = toBigIntSafe(doc?.amount);
        const unlocked = toBigIntSafe(doc?.unlocked_amount);
        const currentLockedAmount = amount > unlocked ? amount - unlocked : 0n;
        return { doc, lockId, amount, unlocked, currentLockedAmount };
      })
      .filter((entry) => entry.lockId);

    const lockRecords = await Promise.all(
      lockableDocs.map(async ({ doc, lockId, amount, unlocked, currentLockedAmount }) => {
        const resolvedChainId = Number(doc?.chain_id || chainId);
        let title =
          doc?.solana_details?.locker_title ||
          (doc?.is_liquidity ? "Liquidity Lock" : `Lock ${lockId}`);
        let cycleValue = doc?.solana_details?.locker_title ? parseCycleDays(title) : 0;
        let cycleUnit = "days";
        let cycleSeconds = 0;
        let lockDate = toPositiveSafeNumber(doc?.lock_date);
        let expiredAt = toPositiveSafeNumber(doc?.expired);
        let tgePercentBps = 0;
        let cycleReleasePercentBps = 0;

        if (isSupportedEvmChain(resolvedChainId)) {
          const record = await fetchPinklockRecordOnChain({
            chainId: resolvedChainId,
            lockId,
            lockVersion: doc?.lock_version
          });
          if (record) {
            title = record.title || title;
            cycleSeconds = record.cycle || 0;
            cycleUnit = getPinklockCycleUnit(resolvedChainId);
            cycleValue = normalizePinklockCycleValue(cycleSeconds, resolvedChainId);
          }
        } else if (resolvedChainId === 501424) {
          const record = await fetchSolanaPinklockRecord(doc?.solana_details?.locker_pubkey);
          if (record) {
            title = record.title || title;
            cycleSeconds = record.cycleSeconds || 0;
            cycleUnit = "days";
            cycleValue = normalizePinklockCycleValue(cycleSeconds, resolvedChainId);
            lockDate = record.lockDate || lockDate;
            expiredAt = record.unlockDate || expiredAt;
            tgePercentBps = record.tgePercentBps || 0;
            cycleReleasePercentBps = record.cycleReleasePercentBps || 0;
          }
        }

        const cycleText = formatPinklockCycleText(cycleValue, cycleUnit);

        return {
          lockId,
          title,
          cycleValue,
          cycleSeconds,
          cycleUnit,
          cycleText,
          cycleDays: cycleUnit === "days" ? cycleValue : 0,
          lockDate,
          expiredAt,
          isLiquidity: Boolean(doc?.is_liquidity),
          isUnlocked: currentLockedAmount <= 0n,
          tgePercentBps,
          tgePercent: percentFromBps(tgePercentBps),
          cycleReleasePercentBps,
          cycleReleasePercent: percentFromBps(cycleReleasePercentBps),
          amount: amount.toString(),
          unlockedAmount: unlocked.toString(),
          currentLockedAmount: currentLockedAmount.toString()
        };
      })
    );

    const mapped = mapTokenomicsWithLockRecords(pageProps, lockRecords);

    res.status(200).json({
      source: {
        url: target,
        fetchedAt: new Date().toISOString(),
        mode: sourceMode
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
