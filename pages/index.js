import { useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import {
  getChainName,
  getDefaultEvmRpcUrl,
  getPinksaleLaunchpadUrl
} from "../lib/pinksale-chains";

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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NON_EVM_RPC_PROXY = "/api/non-evm-rpc";
const SOLANA_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PRESALE_POOL_ABI = [
  "function poolStates() view returns (uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)"
];

function makePoolKey(chainId, addr) {
  if (!chainId || !addr || typeof addr !== "string") return null;
  return String(chainId) + ":" + addr.toLowerCase();
}

function getLocalDetailUrl(chainId, poolAddress) {
  const q = new URLSearchParams({
    chainId: String(chainId || ""),
    poolAddress: String(poolAddress || "")
  });
  return `/details?${q.toString()}`;
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
  const scaled = (value * 100000000n) / total;
  return Number(scaled) / 1000000;
}

function getCardTokenomicsSegments(doc) {
  const pool = doc?.pool || {};
  const token = doc?.token || {};
  const risk = doc?.riskDetails || pool?.riskDetails || {};

  const totalSupply = toBigIntSafe(risk.totalSupply || token.totalSupply);
  if (totalSupply <= 0n) return [];

  const liquidity = toBigIntSafe(risk.tokensForLiquidity);
  const unlocked = toBigIntSafe(risk.totalUnlock);
  const burnt = toBigIntSafe(risk.totalBurned);
  const locked = toBigIntSafe(risk.totalLocked);

  let presale = totalSupply - liquidity - unlocked - burnt - locked;
  if (presale < 0n) presale = 0n;

  const segments = [
    { label: "Presale", percent: pct6(presale, totalSupply), color: "#fd728f" },
    { label: "Liquidity", percent: pct6(liquidity, totalSupply), color: "#049bff" },
    { label: "Unlocked", percent: pct6(unlocked, totalSupply), color: "#ffcd56" }
  ].filter((x) => x.percent > 0);

  return segments;
}

function getConicGradient(stops) {
  if (!stops.length) return "conic-gradient(#334155 0% 100%)";
  let acc = 0;
  const chunks = stops.map((s) => {
    const from = acc;
    const to = acc + s.value;
    acc = to;
    return `${s.color} ${from}% ${to}%`;
  });
  if (acc < 100) {
    chunks.push(`transparent ${acc}% 100%`);
  }
  return `conic-gradient(${chunks.join(", ")})`;
}

async function callNonEvmRpc(chain, body) {
  const res = await fetch(NON_EVM_RPC_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chain,
      ...body
    })
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error || `Non-EVM RPC request failed (${res.status})`);
  }
  return json;
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

function normalizeChainId(chainId) {
  const value = Number(chainId);
  return Number.isFinite(value) ? value : null;
}

function matchesStatusFilter(doc, filter, nowSec) {
  const pool = doc?.pool || {};
  const state = pool.state != null ? Number(pool.state) : null;
  const startTimeSec = pool.startTime != null ? Number(pool.startTime) : null;
  const endTimeSec = pool.endTime != null ? Number(pool.endTime) : null;
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

  if (filter === "UPCOMING") {
    if (startTimeSec != null && startTimeSec > 0) {
      return nowSec < startTimeSec && state !== 2;
    }
    return state === 0;
  }

  return true;
}

function matchesSelectedChains(doc, selectedChainIdSet) {
  if (!selectedChainIdSet) return true;
  const chainId = normalizeChainId(doc?.chainId);
  return chainId != null && selectedChainIdSet.has(chainId);
}

function getChainFilterLabel(chainOptions, selectedChainIds, allChainsSelected) {
  if (!chainOptions.length || allChainsSelected) return "All chains";
  if (!selectedChainIds.length) return "No chains";
  if (selectedChainIds.length === 1) {
    return getChainName(selectedChainIds[0]);
  }
  return `${selectedChainIds.length} selected`;
}

export default function MarketFlowV2Page() {
  const [page, setPage] = useState(1);
  const [allDocs, setAllDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL"); // ALL | LIVE | UPCOMING
  const [selectedChainIds, setSelectedChainIds] = useState(null);
  const [chainFilterOpen, setChainFilterOpen] = useState(false);
  const [liveOverrides, setLiveOverrides] = useState({});
  const [nowMs, setNowMs] = useState(Date.now());
  const chainFilterRef = useRef(null);

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

  const chainOptions = useMemo(() => {
    const counts = new Map();

    for (const doc of allDocs) {
      const chainId = normalizeChainId(doc?.chainId);
      if (chainId == null) continue;
      counts.set(chainId, (counts.get(chainId) || 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([chainId, count]) => ({
        chainId,
        count,
        name: getChainName(chainId)
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.chainId - b.chainId);
  }, [allDocs]);

  const allChainIds = useMemo(() => chainOptions.map((option) => option.chainId), [chainOptions]);

  const selectedChainIdList = useMemo(() => {
    if (selectedChainIds === null) return allChainIds;

    const allowedIds = new Set(allChainIds);
    return selectedChainIds.filter((chainId) => allowedIds.has(chainId));
  }, [selectedChainIds, allChainIds]);

  const allChainsSelected =
    selectedChainIds === null || selectedChainIdList.length === allChainIds.length;

  const selectedChainIdSet = useMemo(() => {
    if (selectedChainIds === null) return null;
    return new Set(selectedChainIdList);
  }, [selectedChainIds, selectedChainIdList]);

  const chainFilterLabel = useMemo(
    () => getChainFilterLabel(chainOptions, selectedChainIdList, allChainsSelected),
    [chainOptions, selectedChainIdList, allChainsSelected]
  );

  useEffect(() => {
    if (!chainFilterOpen) return undefined;

    function handleMouseDown(event) {
      if (chainFilterRef.current && !chainFilterRef.current.contains(event.target)) {
        setChainFilterOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [chainFilterOpen]);

  const filteredDocs = useMemo(() => {
    const nowSec = nowMs / 1000;
    return allDocs.filter(
      (doc) => matchesStatusFilter(doc, filter, nowSec) && matchesSelectedChains(doc, selectedChainIdSet)
    );
  }, [allDocs, filter, nowMs, selectedChainIdSet]);

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

  function handleToggleAllChains() {
    setSelectedChainIds(allChainsSelected ? [] : null);
    setPage(1);
  }

  function handleToggleChain(chainId) {
    setSelectedChainIds((prev) => {
      const availableIds = allChainIds;
      const baseIds =
        prev === null
          ? availableIds
          : prev.filter((value) => availableIds.includes(value));

      if (baseIds.includes(chainId)) {
        return baseIds.filter((value) => value !== chainId);
      }

      const nextIds = [...baseIds, chainId].sort((a, b) => a - b);
      return nextIds.length === availableIds.length ? null : nextIds;
    });
    setPage(1);
  }

  useEffect(() => {
    let stopped = false;

    async function fetchPoolFromRpc(doc) {
      const pool = doc.pool || {};
      const currency = doc.currency || {};
      const chainId = normalizeChainId(doc?.chainId);
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

            const json = await callNonEvmRpc("solana", body);
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
            const json = await callNonEvmRpc("solana", body);
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
            const json = await callNonEvmRpc("solana", body);
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

      const rpcUrl = getDefaultEvmRpcUrl(chainId);
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
      const docsForFilter = allDocs.filter(
        (doc) => matchesStatusFilter(doc, filter, nowSec) && matchesSelectedChains(doc, selectedChainIdSet)
      );

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
  }, [page, filter, allDocs, selectedChainIdSet]);

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
        <div
          ref={chainFilterRef}
          style={{ position: "relative" }}
        >
          <button
            onClick={() => setChainFilterOpen((open) => !open)}
            style={{
              padding: "0.25rem 0.7rem",
              borderRadius: 999,
              border: chainFilterOpen
                ? "1px solid #38bdf8"
                : "1px solid #4b5563",
              background: chainFilterOpen ? "#0f172a" : "#020617",
              color: "#e5e7eb",
              fontSize: "0.8rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.45rem"
            }}
          >
            <span>Chains: {chainFilterLabel}</span>
            <span style={{ color: "#9ca3af", fontSize: "0.72rem" }}>
              {chainFilterOpen ? "▲" : "▼"}
            </span>
          </button>

          {chainFilterOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 0.5rem)",
                left: 0,
                width: 260,
                maxHeight: 320,
                overflowY: "auto",
                padding: "0.55rem",
                borderRadius: "0.75rem",
                border: "1px solid #1f2937",
                background: "#0f172a",
                boxShadow: "0 18px 48px rgba(2, 6, 23, 0.55)",
                zIndex: 20
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  padding: "0.4rem 0.45rem",
                  borderRadius: "0.55rem",
                  background: allChainsSelected ? "#111827" : "transparent",
                  color: "#e5e7eb",
                  cursor: "pointer",
                  marginBottom: "0.35rem"
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={allChainsSelected}
                    onChange={handleToggleAllChains}
                  />
                  <span>All chains</span>
                </span>
                <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                  {allDocs.length}
                </span>
              </label>

              <div
                style={{
                  borderTop: "1px solid #1f2937",
                  paddingTop: "0.35rem"
                }}
              >
                {chainOptions.map((option) => {
                  const checked = allChainsSelected || selectedChainIdSet?.has(option.chainId);
                  return (
                    <label
                      key={option.chainId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        padding: "0.38rem 0.45rem",
                        borderRadius: "0.55rem",
                        background: checked ? "#111827" : "transparent",
                        color: "#e5e7eb",
                        cursor: "pointer"
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <input
                          type="checkbox"
                          checked={Boolean(checked)}
                          onChange={() => handleToggleChain(option.chainId)}
                        />
                        <span>{option.name}</span>
                      </span>
                      <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                        {option.count}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "0.75rem"
        }}
      >
        {pageDocs.map((e, idx) => {
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
          const tokSegments = getCardTokenomicsSegments(e);
          const tokTotal = tokSegments.reduce((sum, s) => sum + s.percent, 0);
          const tokGradient =
            tokTotal > 0
              ? getConicGradient(
                  tokSegments.map((s) => ({
                    color: s.color,
                    value: (s.percent / tokTotal) * 100
                  }))
                )
              : getConicGradient([]);

          const cardKey =
            e.eventKey ||
            makePoolKey(chainId, poolAddress) ||
            `${e.transactionHash || "tx"}-${e.logIndex ?? "log"}-${startIdx + idx}`;

          return (
            <div
              key={cardKey}
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
                {tokSegments.length > 0 && (
                  <div
                    style={{
                      display: "grid",
                      justifyItems: "center",
                      gap: 4,
                      minWidth: 70
                    }}
                    title={tokSegments
                      .map((s) => `${s.label}: ${s.percent.toFixed(2)}%`)
                      .join(" | ")}
                  >
                    <div
                      style={{
                        width: 58,
                        height: 58,
                        borderRadius: "50%",
                        background: tokGradient,
                        position: "relative",
                        border: "1px solid #1f2937"
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          width: 30,
                          height: 30,
                          left: "50%",
                          top: "50%",
                          transform: "translate(-50%, -50%)",
                          borderRadius: "50%",
                          background: "#020617",
                          border: "1px solid #1f2937"
                        }}
                      />
                    </div>
                    <div style={{ fontSize: "0.62rem", color: "#9ca3af" }}>
                      Tokenomics
                    </div>
                  </div>
                )}
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

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.8rem",
                  color: "#9ca3af"
                }}
              >
                <span>Details</span>
                <strong style={{ color: "#e5e7eb", fontWeight: 500 }}>
                  {poolAddress ? (
                    <a
                      href={getLocalDetailUrl(chainId, poolAddress)}
                      style={{
                        color: "#60a5fa",
                        textDecoration: "none"
                      }}
                    >
                      Open
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
