import { useEffect, useState } from "react";
import Script from "next/script";

const PAGE_SIZE = 20;

function mapPoolTypeToDisplay(rawPoolType) {
  if (rawPoolType == null) return "Presale";

  if (typeof rawPoolType === "string") {
    const v = rawPoolType.toLowerCase();
    if (v === "subscription") return "Subscription";
    if (v === "fairlaunch") return "Fair Launch";
    if (v === "auction") return "Auction";
    return "Presale";
  }

  const n = Number(rawPoolType);
  if (n === 4) return "Subscription";
  if (n === 1) return "Fair Launch";
  return "Presale";
}

const CHAIN_ID_TO_NAME = {
  1: "Ethereum",
  56: "BNB Chain",
  137: "Polygon",
  42161: "Arbitrum",
  8453: "Base",
  7000: "ZetaChain",
  501424: "Solana",
  3797: "Alvey"
};

const EVM_RPC_BY_CHAIN_ID = {
  1: "https://ethereum.publicnode.com",
  56: "https://bsc-dataseed.binance.org/",
  137: "https://polygon-bor.publicnode.com",
  42161: "https://arbitrum-one.publicnode.com",
  8453: "https://base.publicnode.com",
  7000: "https://zetachain-evm.blockpi.network/v1/rpc/public",
  3797: "https://rpc.alvey.io"
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ||
  "https://api.mainnet-beta.solana.com";
const SOLANA_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PRESALE_POOL_ABI = [
  "function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)"
];

function getChainName(chainId) {
  const n = Number(chainId);
  if (!Number.isFinite(n)) return String(chainId ?? "-");
  return CHAIN_ID_TO_NAME[n] || `Chain ${n}`;
}

function makePoolKey(chainId, addr) {
  if (!chainId || !addr || typeof addr !== "string") return null;
  return String(chainId) + ":" + addr.toLowerCase();
}

function getChainSlug(chainId) {
  const n = Number(chainId);
  if (!Number.isFinite(n)) return null;
  if (n === 1) return "eth";
  if (n === 56) return "bsc";
  if (n === 137) return "polygon";
  if (n === 42161) return "arbitrum";
  if (n === 8453) return "base";
  if (n === 7000) return "zetachain";
  if (n === 3797) return "alvey";
  if (n === 501424) return "solana";
  return null;
}

function getPinksaleLaunchpadUrl(chainId, poolAddress) {
  const slug = getChainSlug(chainId);
  if (!slug || !poolAddress) {
    return (
      "https://www.pinksale.finance/launchpad/" +
      encodeURIComponent(poolAddress || "")
    );
  }
  if (slug === "solana") {
    return (
      "https://www.pinksale.finance/solana/launchpad/" +
      encodeURIComponent(poolAddress)
    );
  }
  return (
    "https://www.pinksale.finance/launchpad/" +
    slug +
    "/" +
    encodeURIComponent(poolAddress)
  );
}

function shortAddr(addr, len = 6) {
  if (!addr || typeof addr !== "string") return "";
  if (addr.length <= len * 2 + 3) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

function formatNumber(x) {
  if (x == null || x === "") return "-";
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  if (Math.abs(n) >= 1_000_000) {
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (Math.abs(n) >= 1_000) {
    return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  }
  return n.toFixed(2).replace(/\.00$/, "");
}

function tsToTimeString(tsMs) {
  if (!tsMs) return "";
  const d = new Date(tsMs);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function getCountdownParts(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  }
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return { days, hours, minutes, seconds };
}

function pad2(n) {
  return n.toString().padStart(2, "0");
}

export default function MarketFlowV2Page() {
  const [page, setPage] = useState(1);
  const [allDocs, setAllDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL"); // ALL | LIVE | UPCOMING
  const [liveOverrides, setLiveOverrides] = useState({});
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        // Load from a local snapshot produced by
        // fetch-market-flow-v2-snapshot.js
        const res = await fetch("/market-flow-snapshot.json", {
          method: "GET"
        });
        const text = await res.text();

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("Snapshot is not valid JSON");
        }

        if (!cancelled) {
          const docs = Array.isArray(json.docs) ? json.docs : [];
          setAllDocs(docs);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e && e.message ? e.message : String(e));
          setAllDocs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const filteredDocs = allDocs.filter((d) => {
    const pool = d.pool || {};
    const state =
      pool.state != null ? Number(pool.state) : null;
    const startTimeSec =
      pool.startTime != null ? Number(pool.startTime) : null;
    const endTimeSec =
      pool.endTime != null ? Number(pool.endTime) : null;
    const nowSec = nowMs / 1000;
    const inWindow =
      startTimeSec != null &&
      endTimeSec != null &&
      startTimeSec > 0 &&
      endTimeSec > 0 &&
      nowSec >= startTimeSec &&
      nowSec < endTimeSec;

    if (filter === "LIVE") {
      // Live when in time window and not cancelled.
      return inWindow && state !== 2;
    }
    if (filter === "UPCOMING") {
      // Upcoming when before start time and not cancelled.
      if (startTimeSec != null && startTimeSec > 0) {
        return nowSec < startTimeSec && state !== 2;
      }
      return state === 0;
    }
    return true;
  });

  const totalPages =
    filteredDocs.length > 0
      ? Math.ceil(filteredDocs.length / PAGE_SIZE)
      : 1;
  const currentPage =
    page > totalPages ? totalPages : page;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const endIdx = startIdx + PAGE_SIZE;
  const pageDocs = filteredDocs.slice(startIdx, endIdx);

  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;

  useEffect(() => {
    let stopped = false;

    async function fetchPoolFromRpc(doc) {
      const pool = doc.pool || {};
      const currency = doc.currency || {};
      const chainId = doc.chainId;
      const poolAddress = pool.address;

      // Solana (chainId 501424): use Solana RPC to read WSOL/SPL raised.
      if (chainId === 501424 && poolAddress) {
        try {
          let normalized = null;

          // Fetch all SPL token accounts owned by this address via the SPL Token program,
          // then sum balances per mint and pick the mint that matches the pool currency.
          if (
            currency.address &&
            typeof currency.address === "string"
          ) {
            const decimals =
              currency.decimals != null
                ? Number(currency.decimals)
                : 9;

            const body = {
              jsonrpc: "2.0",
              id: 1,
              method: "getTokenAccountsByOwner",
              params: [
                poolAddress,
                {
                  programId:
                    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
                },
                { encoding: "jsonParsed" }
              ]
            };

            const res = await fetch(SOLANA_RPC, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const json = await res.json();
            const value = json && json.result && json.result.value;
            if (Array.isArray(value)) {
              // Group by mint and sum raw amounts.
              const byMint = new Map();
              for (const acc of value) {
                const info =
                  acc &&
                  acc.account &&
                  acc.account.data &&
                  acc.account.data.parsed &&
                  acc.account.data.parsed.info;
                if (!info) continue;
                const mint = info.mint;
                const tokenAmount = info.tokenAmount || {};
                const amtStr = tokenAmount.amount;
                const decs =
                  typeof tokenAmount.decimals === "number"
                    ? tokenAmount.decimals
                    : decimals;
                if (!mint || typeof amtStr !== "string") continue;
                let raw;
                try {
                  raw = BigInt(amtStr);
                } catch {
                  continue;
                }
                const prev = byMint.get(mint) || {
                  raw: 0n,
                  decimals: decs
                };
                prev.raw += raw;
                prev.decimals = decs;
                byMint.set(mint, prev);
              }

              const wantedMint = currency.address;
              const entry = byMint.get(wantedMint);
              if (entry) {
                const useDecs =
                  entry.decimals != null ? entry.decimals : decimals;
                normalized =
                  useDecs >= 0
                    ? Number(entry.raw) / Math.pow(10, useDecs)
                    : Number(entry.raw);
              }
            }
          }

          // Fallback for WSOL pools where the pool address itself
          // may be the token account (owner = token program, not pool).
          if (
            normalized == null &&
            currency.address === SOLANA_WRAPPED_SOL_MINT
          ) {
            const body = {
              jsonrpc: "2.0",
              id: 1,
              method: "getTokenAccountBalance",
              params: [poolAddress, { commitment: "confirmed" }]
            };
            const res = await fetch(SOLANA_RPC, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const json = await res.json();
            const val = json && json.result && json.result.value;
            if (val && typeof val.amount === "string") {
              const amtStr = val.amount;
              const decs =
                val.decimals != null ? Number(val.decimals) : 9;
              try {
                const raw = BigInt(amtStr);
                normalized =
                  decs >= 0
                    ? Number(raw) / Math.pow(10, decs)
                    : Number(raw);
              } catch {
                // ignore parse errors
              }
            }
          }

          // Fallback: if no SPL balance found, try native SOL balance.
          if (normalized == null) {
            const body = {
              jsonrpc: "2.0",
              id: 1,
              method: "getBalance",
              params: [poolAddress, { commitment: "confirmed" }]
            };
            const res = await fetch(SOLANA_RPC, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const json = await res.json();
            const lamports =
              json &&
              json.result &&
              typeof json.result.value === "number"
                ? json.result.value
                : null;
            if (lamports != null) {
              normalized = lamports / 1e9;
            }
          }

          if (normalized == null) return null;

          return {
            normalizedRaised: normalized
          };
        } catch {
          return null;
        }
      }

      // EVM chains: use ethers + poolStates().
      if (typeof window === "undefined" || !window.ethers) return null;
      const { ethers } = window;

      const rpcUrl = EVM_RPC_BY_CHAIN_ID[chainId];
      if (!rpcUrl || !poolAddress) return null;

      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const contract = new ethers.Contract(
          poolAddress,
          PRESALE_POOL_ABI,
          provider
        );

        const states = await contract.poolStates();
        const stateValue =
          (states && (states.state ?? states[0])) != null
            ? states.state ?? states[0]
            : null;
        const totalRaisedRaw =
          (states && (states.totalRaised ?? states[2])) != null
            ? states.totalRaised ?? states[2]
            : null;

        if (totalRaisedRaw == null) return null;

        const asString =
          typeof totalRaisedRaw === "bigint"
            ? totalRaisedRaw.toString()
            : totalRaisedRaw && typeof totalRaisedRaw.toString === "function"
            ? totalRaisedRaw.toString()
            : String(totalRaisedRaw);

        const bn = BigInt(asString);

        const decimals =
          currency.decimals != null ? Number(currency.decimals) : 18;
        const normalized =
          decimals >= 0
            ? Number(bn) / Math.pow(10, decimals)
            : Number(bn);

        return {
          totalRaisedWei: bn.toString(),
          normalizedRaised: normalized,
          state:
            stateValue != null
              ? Number(
                  typeof stateValue === "bigint"
                    ? stateValue
                    : stateValue.toString()
                )
              : null
        };
      } catch {
        return null;
      }
    }

    async function poll() {
      const nowSec = Date.now() / 1000;

      // Recompute the slice of docs for the current filter + page,
      // but do not depend on nowMs/stateful filteredDocs to avoid
      // recreating the interval every second.
      let docsForFilter = allDocs;
      if (filter === "LIVE" || filter === "UPCOMING") {
        docsForFilter = allDocs.filter((d) => {
          const pool = d.pool || {};
          const state =
            pool.state != null ? Number(pool.state) : null;
          const startTimeSec =
            pool.startTime != null ? Number(pool.startTime) : null;
          const endTimeSec =
            pool.endTime != null ? Number(pool.endTime) : null;
          const inWindow =
            startTimeSec != null &&
            endTimeSec != null &&
            startTimeSec > 0 &&
            endTimeSec > 0 &&
            nowSec >= startTimeSec &&
            nowSec < endTimeSec;

          if (filter === "LIVE") {
            return inWindow && state !== 2;
          }
          // UPCOMING
          if (startTimeSec != null && startTimeSec > 0) {
            return nowSec < startTimeSec && state !== 2;
          }
          return state === 0;
        });
      }

      const localTotalPages =
        docsForFilter.length > 0
          ? Math.ceil(docsForFilter.length / PAGE_SIZE)
          : 1;
      const localCurrentPage =
        page > localTotalPages ? localTotalPages : page;
      const localStartIdx = (localCurrentPage - 1) * PAGE_SIZE;
      const localEndIdx = localStartIdx + PAGE_SIZE;
      const pageDocsLocal = docsForFilter.slice(
        localStartIdx,
        localEndIdx
      );

      const docsToPoll = pageDocsLocal.filter((d) => {
        const pool = d.pool || {};
        const state =
          pool.state != null ? Number(pool.state) : null;
        const startTimeSec =
          pool.startTime != null ? Number(pool.startTime) : null;
        const endTimeSec =
          pool.endTime != null ? Number(pool.endTime) : null;
        const inWindow =
          startTimeSec != null &&
          endTimeSec != null &&
          startTimeSec > 0 &&
          endTimeSec > 0 &&
          nowSec >= startTimeSec &&
          nowSec < endTimeSec;

        const isUpcoming =
          startTimeSec != null &&
          startTimeSec > 0 &&
          nowSec < startTimeSec &&
          state !== 2;

        // Poll both live and upcoming pools (non-cancelled) on the current page.
        return (inWindow && state !== 2) || isUpcoming;
      });

      if (!docsToPoll.length) return;

      const updates = {};
      for (const doc of docsToPoll) {
        const pool = doc.pool || {};
        const chainId = doc.chainId;
        const poolAddress = pool.address;
        const key = makePoolKey(chainId, poolAddress);
        if (!key) continue;
        const live = await fetchPoolFromRpc(doc);
        if (live && !stopped) {
          updates[key] = live;
        }
      }

      if (!stopped && Object.keys(updates).length) {
        setLiveOverrides((prev) => ({ ...prev, ...updates }));
      }
    }

    poll();
    const id = setInterval(poll, 30000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [page, filter, allDocs]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#e5e7eb",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: "1rem"
      }}
    >
      <Script
        src="https://cdn.jsdelivr.net/npm/ethers@6.7.0/dist/ethers.umd.min.js"
        strategy="afterInteractive"
      />
      <h1 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
        Pinksale Market Flow – V2 Cards
      </h1>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "1rem"
        }}
      >
        <button
          onClick={() => canPrev && setPage((p) => Math.max(1, p - 1))}
          disabled={!canPrev}
          style={{
            padding: "0.3rem 0.8rem",
            borderRadius: 999,
            border: "1px solid #4b5563",
            background: "#111827",
            color: "#e5e7eb",
            fontSize: "0.85rem",
            cursor: canPrev ? "pointer" : "default",
            opacity: canPrev ? 1 : 0.4
          }}
        >
          Prev
        </button>
        <button
          onClick={() => canNext && setPage((p) => p + 1)}
          disabled={!canNext}
          style={{
            padding: "0.3rem 0.8rem",
            borderRadius: 999,
            border: "1px solid #4b5563",
            background: "#111827",
            color: "#e5e7eb",
            fontSize: "0.85rem",
            cursor: canNext ? "pointer" : "default",
            opacity: canNext ? 1 : 0.4
          }}
        >
          Next
        </button>
        <span style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
          Page {currentPage}
          {totalPages ? ` / ${totalPages}` : ""}
        </span>
        {filteredDocs.length > 0 && (
          <span style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
            Total events: {filteredDocs.length}
          </span>
        )}
      </div>

      {loading && <div style={{ marginBottom: "0.5rem" }}>Loading…</div>}
      {error && (
        <div
          style={{
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
            color: "#fecaca"
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          flexWrap: "wrap"
        }}
      >
        {["ALL", "LIVE", "UPCOMING"].map((key) => {
          const label =
            key === "ALL"
              ? "All"
              : key === "LIVE"
              ? "Live"
              : "Upcoming";
          const active = filter === key;
          return (
            <button
              key={key}
              onClick={() => {
                setFilter(key);
                setPage(1);
              }}
              style={{
                padding: "0.25rem 0.7rem",
                borderRadius: 999,
                border: active
                  ? "1px solid #6366f1"
                  : "1px solid #4b5563",
                background: active ? "#1d2438" : "#020617",
                color: active ? "#e5e7eb" : "#9ca3af",
                fontSize: "0.8rem",
                cursor: "pointer"
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "0.75rem"
        }}
      >
        {pageDocs.map((e) => {
          const token = e.token || {};
          const currency = e.currency || {};
          const pool = e.pool || {};
          const meta = e.metadata || {};

          let poolDetails = {};
          if (typeof pool.poolDetails === "string" && pool.poolDetails.trim()) {
            try {
              poolDetails = JSON.parse(pool.poolDetails);
            } catch {
              poolDetails = {};
            }
          }

          const logoUrl = poolDetails.ab || poolDetails.a || null;

          let kyc = null;
          if (
            typeof pool.kycDetails === "string" &&
            pool.kycDetails.trim()
          ) {
            try {
              kyc = JSON.parse(pool.kycDetails);
            } catch {
              kyc = null;
            }
          }

          const hasKyc = !!(kyc && kyc.kyc);
          const hasAudit = !!kyc;
          const hasDoxx = !!pool.hasDoxx || !!(kyc && kyc.dox);
          const hasBased = !!pool.hasBased;

          const lockSeconds = pool.liquidityLockDuration || 0;
          const lockDays = Math.floor(Number(lockSeconds || 0) / 86400);
          const isLocked = lockDays > 0;

          const raisedPercent =
            meta.raisedPercent != null
              ? Number(meta.raisedPercent)
              : null;

          let stateLabel = "Unknown";
          const poolKey = makePoolKey(e.chainId, pool.address);
          const liveOverride =
            poolKey && liveOverrides[poolKey]
              ? liveOverrides[poolKey]
              : null;
          const stateFromOverride =
            liveOverride && liveOverride.state != null
              ? Number(liveOverride.state)
              : null;
          const state =
            stateFromOverride != null
              ? stateFromOverride
              : pool.state != null
              ? Number(pool.state)
              : null;
          const startTimeSec =
            pool.startTime != null ? Number(pool.startTime) : null;
          const endTimeSec =
            pool.endTime != null ? Number(pool.endTime) : null;
          const nowSec = nowMs / 1000;
          const inWindow =
            startTimeSec != null &&
            endTimeSec != null &&
            startTimeSec > 0 &&
            endTimeSec > 0 &&
            nowSec >= startTimeSec &&
            nowSec < endTimeSec;
          const isTimeUp =
            endTimeSec != null && endTimeSec > 0 && nowSec >= endTimeSec;

          if (state === 2) {
            stateLabel = "Cancelled";
          } else if (isTimeUp && state === 1) {
            stateLabel = "Completed";
          } else if (inWindow && state !== 2) {
            stateLabel = "Live";
          } else if (startTimeSec != null && startTimeSec > 0 && nowSec < startTimeSec) {
            stateLabel = "Upcoming";
          }

          const tokenName = token.name || "Unknown";
          const tokenSymbol = token.symbol || null;
          const saleName = tokenName;
          const quoteSymbol = currency.symbol || "";
          const raised = pool.totalRaised || null;
          const softCapRaw = pool.softCap || null;
          const hardCapRaw = pool.hardCap || null;
          const chainId = e.chainId;
          const poolAddress = pool.address;
          const decimals =
            currency.decimals != null ? Number(currency.decimals) : 18;
          const baseNormalizedRaised =
            raised != null
              ? Number(raised) / Math.pow(10, decimals)
              : null;
          const normalizedSoftCap =
            softCapRaw != null
              ? Number(softCapRaw) / Math.pow(10, decimals)
              : null;
          const normalizedHardCap =
            hardCapRaw != null
              ? Number(hardCapRaw) / Math.pow(10, decimals)
              : null;

          const normalizedRaised =
            liveOverride && typeof liveOverride.normalizedRaised === "number"
              ? liveOverride.normalizedRaised
              : baseNormalizedRaised;

          let progressPercent = null;
          if (
            normalizedRaised != null &&
            normalizedHardCap != null &&
            normalizedHardCap > 0
          ) {
            progressPercent = Math.max(
              0,
              Math.min(100, (normalizedRaised / normalizedHardCap) * 100)
            );
          } else if (raisedPercent != null) {
            progressPercent = Math.max(
              0,
              Math.min(100, raisedPercent)
            );
          }

          const poolTypeDisplay = mapPoolTypeToDisplay(
            pool.poolType != null ? pool.poolType : pool.pool_type
          );

          return (
            <div
              key={e.eventKey || `${e.transactionHash || ""}-${e.logIndex || ""}`}
              style={{
                background: "#111827",
                borderRadius: "0.75rem",
                padding: "0.75rem 0.9rem",
                border: "1px solid #1f2937",
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem"
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "0.5rem"
                }}
              >
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  {logoUrl && (
                    <img
                      src={logoUrl}
                      alt={saleName}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "999px",
                        objectFit: "cover",
                        flexShrink: 0
                      }}
                    />
                  )}
                  <div>
                    <div
                      style={{
                        fontSize: "0.95rem",
                        fontWeight: 600,
                        wordBreak: "break-word"
                      }}
                    >
                      {saleName}
                    </div>
                    {tokenSymbol && (
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "#9ca3af",
                          marginTop: 2
                        }}
                      >
                        {tokenSymbol}
                      </div>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "#9ca3af",
                    textAlign: "right"
                  }}
                >
                  {(stateLabel === "Upcoming" || stateLabel === "Live") && (
                    <div
                      style={{
                        marginBottom: 4,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-end",
                        gap: 2
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color:
                            stateLabel === "Upcoming"
                              ? "#f97316"
                              : "#22c55e"
                        }}
                      >
                        {stateLabel === "Upcoming"
                          ? "Sale starts in"
                          : "Sale ends in"}
                      </div>
                      {(() => {
                        const now = nowMs / 1000;
                        const targetSec =
                          stateLabel === "Upcoming"
                            ? startTimeSec
                            : endTimeSec;
                        const remaining =
                          targetSec != null ? targetSec - now : null;
                        const parts = getCountdownParts(remaining);
                        const blocks = [
                          {
                            label: "D",
                            value: parts.days.toString()
                          },
                          { label: "H", value: pad2(parts.hours) },
                          { label: "M", value: pad2(parts.minutes) },
                          { label: "S", value: pad2(parts.seconds) }
                        ];
                        return (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4
                            }}
                          >
                            {blocks.map((b) => (
                              <div
                                key={b.label}
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  alignItems: "center",
                                  minWidth: 24
                                }}
                              >
                                <div
                                  style={{
                                    padding:
                                      b.label === "D"
                                        ? "2px 6px"
                                        : "2px 5px",
                                    borderRadius: 4,
                                    background:
                                      "linear-gradient(180deg,#020617,#111827)",
                                    border: "1px solid #1f2937",
                                    boxShadow:
                                      "0 1px 0 #0b1120, inset 0 -1px 0 #020617",
                                    fontSize:
                                      b.label === "D" ? "0.75rem" : "0.8rem",
                                    fontVariantNumeric:
                                      "tabular-nums",
                                    letterSpacing: 0.5
                                  }}
                                >
                                  {b.value}
                                </div>
                                <div
                                  style={{
                                    marginTop: 1,
                                    fontSize: "0.6rem",
                                    color: "#6b7280"
                                  }}
                                >
                                  {b.label}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  <div>
                    Buyers: {pool.contributorCount ?? 0}
                  </div>
                </div>
              </div>

              {(normalizedRaised != null ||
                normalizedSoftCap != null ||
                normalizedHardCap != null) && (
                <div
                  style={{
                    marginTop: "0.5rem",
                    padding: "0.35rem 0.45rem",
                    borderRadius: "0.5rem",
                    background: "#020617",
                    border: "1px solid #1f2937",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                      fontSize: "0.75rem",
                      color: "#9ca3af",
                      flexWrap: "wrap"
                    }}
                  >
                    <span>
                      Raised:{" "}
                      <strong
                        style={{
                          color: "#e5e7eb",
                          fontWeight: 500
                        }}
                      >
                        {normalizedRaised != null
                          ? formatNumber(normalizedRaised)
                          : "-"}
                        {quoteSymbol ? ` ${quoteSymbol}` : ""}
                      </strong>
                    </span>
                    {normalizedSoftCap != null && (
                      <span>
                        Soft cap:{" "}
                        <strong
                          style={{
                            color: "#e5e7eb",
                            fontWeight: 500
                          }}
                        >
                          {formatNumber(normalizedSoftCap)}
                          {quoteSymbol ? ` ${quoteSymbol}` : ""}
                        </strong>
                      </span>
                    )}
                    {normalizedHardCap != null && (
                      <span>
                        Hard cap:{" "}
                        <strong
                          style={{
                            color: "#e5e7eb",
                            fontWeight: 500
                          }}
                        >
                          {formatNumber(normalizedHardCap)}
                          {quoteSymbol ? ` ${quoteSymbol}` : ""}
                        </strong>
                      </span>
                    )}
                  </div>
                  {progressPercent != null && (
                    <div
                      style={{
                        marginTop: 4,
                        display: "flex",
                        alignItems: "center",
                        gap: 8
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          height: 8,
                          borderRadius: 999,
                          background: "#111827",
                          overflow: "hidden"
                        }}
                      >
                        <div
                          style={{
                            width: `${progressPercent}%`,
                            height: "100%",
                            borderRadius: 999,
                            background:
                              "linear-gradient(90deg, #22c55e, #4ade80)"
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "#e5e7eb",
                          minWidth: 40,
                          textAlign: "right"
                        }}
                      >
                        {progressPercent < 1
                          ? progressPercent.toFixed(2)
                          : progressPercent.toFixed(0)}
                        %
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  gap: "0.35rem",
                  flexWrap: "wrap",
                  marginTop: "0.15rem"
                }}
              >
                <span
                  style={{
                    borderRadius: 999,
                    padding: "0.12rem 0.45rem",
                    fontSize: "0.7rem",
                    border:
                      stateLabel === "Live" || stateLabel === "Completed"
                        ? "1px solid #22c55e" // green
                        : stateLabel === "Upcoming"
                        ? "1px solid #f97316" // orange
                        : stateLabel === "Cancelled"
                        ? "1px solid #ef4444" // red
                        : "1px solid #4b5563",
                    color:
                      stateLabel === "Live" || stateLabel === "Completed"
                        ? "#bbf7d0"
                        : stateLabel === "Upcoming"
                        ? "#fed7aa"
                        : stateLabel === "Cancelled"
                        ? "#fecaca"
                        : "#e5e7eb"
                  }}
                >
                  {stateLabel}
                </span>
                <span
                  style={{
                    borderRadius: 999,
                    padding: "0.12rem 0.45rem",
                    fontSize: "0.7rem",
                    border: "1px solid #6366f1",
                    color: "#e5e7eb"
                  }}
                >
                  {poolTypeDisplay}
                </span>
                {hasKyc && (
                  <span
                    style={{
                      borderRadius: 999,
                      padding: "0.12rem 0.45rem",
                      fontSize: "0.7rem",
                      border: "1px solid #22c55e",
                      color: "#bbf7d0"
                    }}
                  >
                    KYC
                  </span>
                )}
                {hasAudit && (
                  <span
                    style={{
                      borderRadius: 999,
                      padding: "0.12rem 0.45rem",
                      fontSize: "0.7rem",
                      border: "1px solid #38bdf8",
                      color: "#bae6fd"
                    }}
                  >
                    Audit
                  </span>
                )}
                {hasDoxx && (
                  <span
                    style={{
                      borderRadius: 999,
                      padding: "0.12rem 0.45rem",
                      fontSize: "0.7rem",
                      border: "1px solid #f97316",
                      color: "#fed7aa"
                    }}
                  >
                    Doxx
                  </span>
                )}
                {hasBased && (
                  <span
                    style={{
                      borderRadius: 999,
                      padding: "0.12rem 0.45rem",
                      fontSize: "0.7rem",
                      border: "1px solid #a855f7",
                      color: "#e9d5ff"
                    }}
                  >
                    Based
                  </span>
                )}
                <span
                  style={{
                    borderRadius: 999,
                    padding: "0.12rem 0.45rem",
                    fontSize: "0.7rem",
                    border: "1px solid #4b5563",
                    color: "#d1d5db"
                  }}
                >
                  {isLocked
                    ? lockDays > 0
                      ? `Locked ${lockDays}d`
                      : "Locked"
                    : "Unlocked"}
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.8rem",
                  color: "#9ca3af"
                }}
              >
                <span>Chain</span>
                <strong style={{ color: "#e5e7eb", fontWeight: 500 }}>
                  {getChainName(chainId)}
                </strong>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.8rem",
                  color: "#9ca3af"
                }}
              >
                <span>Pool</span>
                <strong style={{ color: "#e5e7eb", fontWeight: 500 }}>
                  {poolAddress ? (
                    <a
                      href={getPinksaleLaunchpadUrl(chainId, poolAddress)}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: "#60a5fa",
                        textDecoration: "none",
                        wordBreak: "break-all"
                      }}
                    >
                      {shortAddr(poolAddress)}
                    </a>
                  ) : (
                    "-"
                  )}
                </strong>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
