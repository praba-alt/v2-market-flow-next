import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
  getChainName,
  getChainSlug,
  getPinksaleLaunchpadUrl,
  isEvmChain
} from "../lib/pinksale-chains";

const FIXED_COLORS = {
  Presale: "#fd728f",
  Liquidity: "#049bff",
  Unlocked: "#ffcd56",
  Burnt: "#96A1B0"
};

function hashLabel(input) {
  let h = 0;
  const s = String(input || "");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorForLabel(label) {
  if (FIXED_COLORS[label]) return FIXED_COLORS[label];
  const hue = hashLabel(label) % 360;
  return hslToHex(hue, 0.62, 0.54);
}

function fmtPct(v) {
  return `${Number(v || 0).toFixed(6).replace(/\.?0+$/, "")}%`;
}

function getConicGradient(stops) {
  if (!stops.length) return "conic-gradient(#ddd 0% 100%)";
  let acc = 0;
  const parts = stops.map((s) => {
    const from = acc;
    const to = acc + s.value;
    acc = to;
    return `${s.color} ${from}% ${to}%`;
  });
  if (acc < 100) parts.push(`transparent ${acc}% 100%`);
  return `conic-gradient(${parts.join(", ")})`;
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

function pow10(n) {
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= 10n;
  return out;
}

function buildBasicSegmentsFromRisk(doc) {
  const risk = doc?.riskDetails || doc?.pool?.riskDetails || {};
  const token = doc?.token || doc?.pool?.token || {};
  const totalSupply = toBigIntSafe(risk.totalSupply || token.totalSupply);
  if (totalSupply <= 0n) return [];

  const liquidity = toBigIntSafe(risk.tokensForLiquidity);
  const unlocked = toBigIntSafe(risk.totalUnlock);
  const burnt = toBigIntSafe(risk.totalBurned);
  const locked = toBigIntSafe(risk.totalLocked);
  let presale = totalSupply - liquidity - unlocked - burnt - locked;
  if (presale < 0n) presale = 0n;

  return [
    { label: "Presale", value: pct6(presale, totalSupply) },
    { label: "Liquidity", value: pct6(liquidity, totalSupply) },
    { label: "Unlocked", value: pct6(unlocked, totalSupply) }
  ].filter((x) => x.value > 0);
}

function addGroupingSeparators(text) {
  return String(text || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTokenAmount(rawValue, decimals) {
  const value = toBigIntSafe(rawValue);
  const places = Number.isFinite(Number(decimals))
    ? Math.max(0, Math.min(30, Math.trunc(Number(decimals))))
    : 18;

  if (places === 0) return addGroupingSeparators(value.toString());

  const unit = pow10(places);
  const whole = value / unit;
  const fraction = value % unit;
  const wholeText = addGroupingSeparators(whole.toString());

  if (fraction === 0n) return wholeText;

  const fractionText = fraction
    .toString()
    .padStart(places, "0")
    .slice(0, 4)
    .replace(/0+$/, "");

  return fractionText ? `${wholeText}.${fractionText}` : wholeText;
}

function formatPercentValue(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return "-";
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function isVestingRecord(record) {
  return (
    Number(record?.cycleValue || 0) > 0 ||
    Number(record?.tgePercentBps || record?.tgePercent || 0) > 0 ||
    Number(record?.cycleReleasePercentBps || record?.cycleReleasePercent || 0) > 0
  );
}

function getUnlockDateParts(unixSeconds) {
  const value = Number(unixSeconds || 0);
  if (!Number.isFinite(value) || value <= 0) return null;

  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return {
    dateText: `${year}.${month}.${day}`,
    timeText: `${hours}:${minutes} UTC`
  };
}

function formatUnlockCountdown(unixSeconds, nowMs) {
  const value = Number(unixSeconds || 0);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(nowMs) || nowMs <= 0) return "";

  const diffMs = value * 1000 - nowMs;
  const absMs = Math.abs(diffMs);

  if (absMs < 60000) {
    return diffMs >= 0 ? "in <1m" : "<1m ago";
  }

  const totalMinutes = Math.floor(absMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const text = `${days}d ${hours}h ${minutes}m`;

  return diffMs >= 0 ? `in ${text}` : `${text} ago`;
}

function formatDurationCompact(totalSeconds) {
  const value = Number(totalSeconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";

  const totalMinutes = Math.floor(value / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && parts.length < 2) parts.push(`${minutes}m`);

  return parts.length ? parts.slice(0, 2).join(" ") : "<1m";
}

function isRecordCurrentlyLocked(record) {
  return toBigIntSafe(record?.currentLockedAmount) > 0n;
}

function getAllocationStatus(record) {
  const locked = toBigIntSafe(record?.currentLockedAmount);
  const unlocked = toBigIntSafe(record?.unlockedAmount);
  if (locked > 0n && unlocked > 0n) return "partial";
  if (locked > 0n) return "locked";
  if (unlocked > 0n) return "unlocked";
  return null;
}

function getStatusMarkerLabel(status) {
  if (status === "locked") return "Locked";
  if (status === "unlocked") return "Unlocked";
  if (status === "partial") return "Partially Unlocked";
  return "";
}

function getSlicePresentation(label, liquidityStatus) {
  const rawLabel = String(label || "").trim();
  const statusMatch = rawLabel.match(/^(.*)\s+\((Locked|Unlocked)\)$/i);
  if (statusMatch) {
    return {
      displayLabel: statusMatch[1],
      status: statusMatch[2].toLowerCase()
    };
  }
  if (rawLabel === "Locked Allocation") {
    return { displayLabel: rawLabel, status: "locked" };
  }
  if (rawLabel === "Unlocked Allocation") {
    return { displayLabel: rawLabel, status: "unlocked" };
  }
  if (rawLabel === "Liquidity" && liquidityStatus) {
    return { displayLabel: rawLabel, status: liquidityStatus };
  }
  return { displayLabel: rawLabel, status: null };
}

function combineAllocationStatuses(records) {
  let hasLocked = false;
  let hasUnlocked = false;
  for (const record of records || []) {
    const status = getAllocationStatus(record);
    if (status === "locked") hasLocked = true;
    if (status === "unlocked") hasUnlocked = true;
    if (status === "partial") {
      hasLocked = true;
      hasUnlocked = true;
    }
  }
  if (hasLocked && hasUnlocked) return "partial";
  if (hasLocked) return "locked";
  if (hasUnlocked) return "unlocked";
  return null;
}

function StatusMarker({ status }) {
  if (!status) return null;

  const label = getStatusMarkerLabel(status);
  const iconStyle = status === "partial" ? styles.statusIconSmall : styles.statusIcon;

  return (
    <span
      aria-label={label}
      title={label}
      style={styles.statusMarker}
    >
      {status === "partial" ? (
        <span style={styles.statusIconPair}>
          <LockClosedIcon style={{ ...styles.statusIconSmall, ...styles.statusLocked }} />
          <LockOpenIcon style={{ ...styles.statusIconSmall, ...styles.statusUnlocked }} />
        </span>
      ) : status === "locked" ? (
        <LockClosedIcon style={{ ...iconStyle, ...styles.statusLocked }} />
      ) : (
        <LockOpenIcon style={{ ...iconStyle, ...styles.statusUnlocked }} />
      )}
    </span>
  );
}

function LockClosedIcon({ style }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={style}>
      <path
        fill="currentColor"
        d="M17 10V8a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1Zm-8 0V8a3 3 0 1 1 6 0v2H9Z"
      />
    </svg>
  );
}

function LockOpenIcon({ style }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={style}>
      <path
        fill="currentColor"
        d="M18 10h-7V8a3 3 0 1 1 6 0h2a5 5 0 1 0-10 0v2H8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Z"
      />
    </svg>
  );
}

function HeaderLabel({ label, meta }) {
  return (
    <span style={styles.thContent}>
      <span>{label}</span>
      {meta ? <span style={styles.thMeta}>{meta}</span> : null}
    </span>
  );
}

function UnlockTimeCell({ expiredAt, nowMs }) {
  const dateParts = getUnlockDateParts(expiredAt);
  const countdown = formatUnlockCountdown(expiredAt, nowMs);

  if (!dateParts) {
    return <div style={styles.timeCell}>-</div>;
  }

  return (
    <div style={styles.timeCell}>
      <div>{dateParts.dateText}</div>
      <div style={styles.timeSub}>{dateParts.timeText}</div>
      {countdown ? <div style={styles.timeMeta}>{countdown}</div> : null}
    </div>
  );
}

export default function PoolDetailsPage() {
  const router = useRouter();
  const chainId = router.query.chainId ? Number(router.query.chainId) : null;
  const poolAddress =
    typeof router.query.poolAddress === "string" ? router.query.poolAddress : "";

  const [poolDoc, setPoolDoc] = useState(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [docError, setDocError] = useState("");

  const [tokenomics, setTokenomics] = useState(null);
  const [loadingTok, setLoadingTok] = useState(false);
  const [tokError, setTokError] = useState("");
  const [nowMs, setNowMs] = useState(null);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!chainId || !poolAddress) return;
    let cancelled = false;
    async function loadDoc() {
      setLoadingDoc(true);
      setDocError("");
      try {
        const res = await fetch("/market-flow-snapshot.json", { cache: "no-store" });
        const text = await res.text();
        const json = JSON.parse(text);
        const docs = Array.isArray(json?.docs) ? json.docs : [];
        const found = docs.find((d) => {
          const p = d?.pool || {};
          return (
            Number(d?.chainId) === Number(chainId) &&
            String(p.address || "").toLowerCase() === String(poolAddress).toLowerCase()
          );
        });
        if (!cancelled) setPoolDoc(found || null);
      } catch (e) {
        if (!cancelled) setDocError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    }
    loadDoc();
    return () => {
      cancelled = true;
    };
  }, [chainId, poolAddress]);

  useEffect(() => {
    if (!chainId || !poolAddress) return;
    let cancelled = false;
    async function loadTok() {
      setLoadingTok(true);
      setTokError("");
      try {
        const qs = new URLSearchParams({
          chainId: String(chainId),
          poolAddress,
          _ts: String(Date.now())
        });
        const chainSlug = getChainSlug(chainId);
        if (chainSlug) {
          qs.set("chain", chainSlug);
        }
        const res = await fetch(`/api/pinksale-tokenomics?${qs.toString()}`, {
          cache: "no-store"
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
        if (!cancelled) setTokenomics(json);
      } catch (e) {
        if (!cancelled) setTokError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoadingTok(false);
      }
    }
    loadTok();
    return () => {
      cancelled = true;
    };
  }, [chainId, poolAddress]);

  const token = poolDoc?.token || tokenomics?.token || {};
  const pool = poolDoc?.pool || {};
  const lockRecords = useMemo(
    () => (Array.isArray(tokenomics?.lockRecords) ? tokenomics.lockRecords : []),
    [tokenomics]
  );
  const liquidityLockRecords = useMemo(
    () =>
      Array.isArray(tokenomics?.mappedTokenomics?.liquidityLockRecords)
        ? tokenomics.mappedTokenomics.liquidityLockRecords
        : [],
    [tokenomics]
  );
  const lpIsBurned =
    Boolean(tokenomics?.rawRiskDetails?.isLpBurned) || Boolean(poolDoc?.riskDetails?.isLpBurned);
  const liquidityLockDuration = Number(pool?.liquidityLockDuration || 0);
  const liquidityStatus = useMemo(() => {
    if (lpIsBurned) return null;
    const statusFromLiquidityLocks = combineAllocationStatuses(liquidityLockRecords);
    if (statusFromLiquidityLocks) return statusFromLiquidityLocks;
    const statusFromRecords = combineAllocationStatuses(
      lockRecords.filter((record) => Boolean(record?.isLiquidity))
    );
    if (statusFromRecords) return statusFromRecords;
    return liquidityLockDuration > 0 ? "locked" : null;
  }, [liquidityLockRecords, lockRecords, lpIsBurned, liquidityLockDuration]);

  const slices = useMemo(() => {
    const detailed = Array.isArray(tokenomics?.mappedTokenomics?.chartSegments)
      ? tokenomics.mappedTokenomics.chartSegments
          .map((x) => {
            const label = String(x?.label || "");
            const presentation = getSlicePresentation(label, liquidityStatus);
            return {
              label,
              displayLabel: presentation.displayLabel,
              status: presentation.status,
              value: Number(x?.percent || 0)
            };
          })
          .filter((x) => x.label && x.value > 0)
      : [];
    if (detailed.length) return detailed;
    return buildBasicSegmentsFromRisk(poolDoc).map((x) => {
      const presentation = getSlicePresentation(x?.label, liquidityStatus);
      return {
        ...x,
        displayLabel: presentation.displayLabel,
        status: presentation.status
      };
    });
  }, [chainId, tokenomics, poolDoc, liquidityStatus]);

  const hasDetailedTokenomics =
    Array.isArray(tokenomics?.mappedTokenomics?.chartSegments) &&
    tokenomics.mappedTokenomics.chartSegments.some((x) => Number(x?.percent || 0) > 0);

  const colorByLabel = useMemo(() => {
    const out = {};
    for (const s of slices) out[s.label] = colorForLabel(s.label);
    return out;
  }, [slices]);

  const gradient = useMemo(() => {
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    if (total <= 0) return getConicGradient([]);
    const normalized = slices.map((s) => ({
      ...s,
      color: colorByLabel[s.label] || "#bbb",
      value: (s.value / total) * 100
    }));
    return getConicGradient(normalized);
  }, [slices, colorByLabel]);

  const tokenDecimals = Number.isFinite(Number(token?.decimals))
    ? Number(token.decimals)
    : Number.isFinite(Number(tokenomics?.token?.decimals))
      ? Number(tokenomics.token.decimals)
      : 18;
  const tokenSymbol =
    (String(tokenomics?.token?.symbol || token?.symbol || "TOKEN").trim() || "TOKEN").toUpperCase();

  const vestingLockRecords = useMemo(
    () => lockRecords.filter((record) => isVestingRecord(record)),
    [lockRecords]
  );

  const scheduledLockRecords = useMemo(
    () => lockRecords.filter((record) => !isVestingRecord(record)),
    [lockRecords]
  );

  const allLockRecords = useMemo(
    () => [...liquidityLockRecords, ...lockRecords],
    [liquidityLockRecords, lockRecords]
  );

  const hasActiveLockRecords = useMemo(
    () => allLockRecords.some((record) => isRecordCurrentlyLocked(record)),
    [allLockRecords]
  );

  const allLockRecordCount = allLockRecords.length;

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <div style={styles.topBar}>
          <a href="/" style={styles.link}>
            Back to list
          </a>
          {chainId && poolAddress ? (
            <a
              href={getPinksaleLaunchpadUrl(chainId, poolAddress)}
              style={styles.link}
              target="_blank"
              rel="noreferrer"
            >
              Open on PinkSale
            </a>
          ) : null}
        </div>

        <h1 style={styles.h1}>Token Details</h1>
        <p style={styles.sub}>
          Chain: {chainId ? `${getChainName(chainId)} (${chainId})` : "-"} | Pool: {poolAddress || "-"}
        </p>

        {(loadingDoc || loadingTok) && <p>Loading details...</p>}
        {docError ? <p style={styles.err}>Pool details error: {docError}</p> : null}
        {tokError ? <p style={styles.err}>Tokenomics error: {tokError}</p> : null}

        <section style={styles.card}>
          <div style={styles.grid2}>
            <div>
              <div style={styles.k}>Token</div>
              <div style={styles.v}>{token?.name || "-"}</div>
            </div>
            <div>
              <div style={styles.k}>Symbol</div>
              <div style={styles.v}>{token?.symbol || "-"}</div>
            </div>
            <div>
              <div style={styles.k}>Contributors</div>
              <div style={styles.v}>{pool?.contributorCount ?? "-"}</div>
            </div>
            <div>
              <div style={styles.k}>Pool State</div>
              <div style={styles.v}>{pool?.state ?? "-"}</div>
            </div>
          </div>
        </section>

        <section style={styles.card}>
          <h2 style={styles.h2}>Tokenomics</h2>
          {!isEvmChain(chainId) && !hasDetailedTokenomics ? (
            <p style={styles.sub}>Showing fallback tokenomics (Presale/Liquidity/Unlocked).</p>
          ) : null}

          {slices.length > 0 ? (
            <div style={styles.chartRow}>
              <div style={{ ...styles.donut, background: gradient }}>
                <div style={styles.hole}>
                  <div style={styles.symbol}>{tokenomics?.token?.symbol || token?.symbol || "TOKEN"}</div>
                </div>
              </div>
              <div style={styles.legend}>
                {slices.map((s) => (
                  <div key={s.label} style={styles.legendItem}>
                    <span style={{ ...styles.swatch, backgroundColor: colorByLabel[s.label] }} />
                    <span style={styles.legendText}>
                      <span style={styles.legendLabelRow}>
                        <span style={styles.titleWithStatus}>
                          <span>{s.displayLabel || s.label}</span>
                          <StatusMarker status={s.status} />
                        </span>
                        <span>
                          : {fmtPct(s.value)}
                        </span>
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section style={styles.card}>
          <div style={styles.sectionHead}>
            <h2 style={styles.h2}>Lock Records</h2>
            {allLockRecordCount > 0 ? (
              <span style={styles.countPill}>
                {allLockRecordCount} record{allLockRecordCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {loadingTok && !tokenomics ? (
            <p style={styles.sub}>Loading lock records...</p>
          ) : allLockRecordCount > 0 ? (
            <>
              {!hasActiveLockRecords ? (
                <p style={styles.sub}>
                  These PinkSale allocations are fully unlocked.
                  {lpIsBurned ? " PinkSale also reports this pool's liquidity as burned." : ""}
                </p>
              ) : null}

              <div style={styles.tableWrap}>
                <div style={styles.tableStack}>
                  {liquidityLockRecords.length > 0 ? (
                    <div style={styles.tableGroup}>
                      <div style={styles.groupLabel}>Liquidity Lock Records</div>
                      <table style={styles.tableCompact}>
                        <thead>
                          <tr>
                            <th style={{ ...styles.th, ...styles.statusTh }}>Lock</th>
                            <th style={styles.th}>Title</th>
                            <th style={styles.th}>
                              <HeaderLabel label="Amount" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlocked" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>Period</th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlock" meta="UTC" />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {liquidityLockRecords.map((record) => (
                            <tr key={record.lockId}>
                              <td style={{ ...styles.td, ...styles.statusTd }}>
                                <StatusMarker status={getAllocationStatus(record)} />
                              </td>
                              <td style={styles.td}>
                                <div style={styles.cellTitle}>{record.title || "Auto Listing Liquidity"}</div>
                                <div style={styles.cellMeta}>
                                  Auto liquidity lock
                                  {record?.isEstimatedUnlockTime
                                    ? " | Est. until finalize"
                                    : ""}
                                </div>
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.amount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.unlockedAmount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatDurationCompact(record.lockDurationSeconds)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                <UnlockTimeCell expiredAt={record.expiredAt} nowMs={nowMs} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {vestingLockRecords.length > 0 ? (
                    <div style={styles.tableGroup}>
                      <div style={styles.groupLabel}>Vesting Lock Records</div>
                      <table style={styles.tableCompact}>
                        <thead>
                          <tr>
                            <th style={{ ...styles.th, ...styles.statusTh }}>Lock</th>
                            <th style={styles.th}>Title</th>
                            <th style={styles.th}>
                              <HeaderLabel label="Amount" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlocked" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>Cycle(d)</th>
                            <th style={styles.th}>Release(%)</th>
                            <th style={styles.th}>TGE(%)</th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlock" meta="UTC" />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {vestingLockRecords.map((record) => (
                            <tr key={record.lockId}>
                              <td style={{ ...styles.td, ...styles.statusTd }}>
                                <StatusMarker status={getAllocationStatus(record)} />
                              </td>
                              <td style={styles.td}>
                                <div style={styles.cellTitle}>{record.title || `Lock ${record.lockId}`}</div>
                                <div style={styles.cellMeta}>Lock #{record.lockId}</div>
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.amount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.unlockedAmount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {Number(record?.cycleValue || 0) > 0 ? record.cycleValue : "-"}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatPercentValue(record.cycleReleasePercent)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatPercentValue(record.tgePercent)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                <UnlockTimeCell expiredAt={record.expiredAt} nowMs={nowMs} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {scheduledLockRecords.length > 0 ? (
                    <div style={styles.tableGroup}>
                      <div style={styles.groupLabel}>Cliff Lock Records</div>
                      <table style={styles.tableCompact}>
                        <thead>
                          <tr>
                            <th style={{ ...styles.th, ...styles.statusTh }}>Lock</th>
                            <th style={styles.th}>Title</th>
                            <th style={styles.th}>
                              <HeaderLabel label="Amount" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlocked" meta={tokenSymbol} />
                            </th>
                            <th style={styles.th}>
                              <HeaderLabel label="Unlock" meta="UTC" />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {scheduledLockRecords.map((record) => (
                            <tr key={record.lockId}>
                              <td style={{ ...styles.td, ...styles.statusTd }}>
                                <StatusMarker status={getAllocationStatus(record)} />
                              </td>
                              <td style={styles.td}>
                                <div style={styles.cellTitle}>{record.title || `Lock ${record.lockId}`}</div>
                                <div style={styles.cellMeta}>Lock #{record.lockId}</div>
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.amount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                {formatTokenAmount(record.unlockedAmount, tokenDecimals)}
                              </td>
                              <td style={{ ...styles.td, ...styles.monoCell }}>
                                <UnlockTimeCell expiredAt={record.expiredAt} nowMs={nowMs} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <p style={styles.sub}>
              No PinkSale allocation records found for this token.
              {lpIsBurned ? " PinkSale reports this pool's liquidity as burned." : ""}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#020617",
    color: "#e5e7eb",
    padding: "1rem",
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  wrap: { maxWidth: 1080, margin: "0 auto", display: "grid", gap: 12 },
  topBar: { display: "flex", gap: 12, flexWrap: "wrap" },
  link: { color: "#60a5fa", textDecoration: "none", fontSize: 14 },
  h1: { margin: 0, fontSize: 30, fontWeight: 700 },
  h2: { margin: 0, fontSize: 22, fontWeight: 600 },
  sub: { margin: 0, color: "#9ca3af" },
  err: { margin: 0, color: "#fecaca" },
  card: {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 12,
    padding: 14,
    display: "grid",
    gap: 12
  },
  grid2: {
    display: "grid",
    gap: 10,
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))"
  },
  k: { fontSize: 12, color: "#9ca3af" },
  v: { fontSize: 16, color: "#e5e7eb", fontWeight: 600, wordBreak: "break-all" },
  chartRow: {
    display: "flex",
    gap: 24,
    alignItems: "center",
    flexWrap: "wrap"
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap"
  },
  countPill: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #1e3a8a",
    background: "#0b1220",
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: 600
  },
  donut: {
    width: 320,
    height: 320,
    borderRadius: "50%",
    position: "relative",
    flexShrink: 0
  },
  hole: {
    position: "absolute",
    width: 160,
    height: 160,
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    background: "#020617",
    display: "grid",
    placeItems: "center"
  },
  symbol: { fontSize: 42, fontWeight: 700, color: "#fd728f" },
  legend: { minWidth: 280, display: "grid", gap: 10 },
  legendItem: { display: "flex", gap: 10, alignItems: "center" },
  legendLabelRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap"
  },
  titleWithStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap"
  },
  swatch: { width: 14, height: 14, borderRadius: 3, display: "inline-block" },
  legendText: { color: "#e5e7eb" },
  statusMarker: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    flexShrink: 0
  },
  statusIcon: {
    width: 18,
    height: 18,
    display: "block",
    flexShrink: 0
  },
  statusIconSmall: {
    width: 15,
    height: 15,
    display: "block",
    flexShrink: 0
  },
  statusIconPair: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2
  },
  statusLocked: {
    color: "#4ade80"
  },
  statusUnlocked: {
    color: "#fb923c"
  },
  tableWrap: {
    border: "1px solid #1f2937",
    borderRadius: 10,
    overflowX: "auto"
  },
  tableStack: {
    display: "grid",
    gap: 12
  },
  tableGroup: {
    display: "grid",
    gap: 6
  },
  groupLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.3,
    color: "#cbd5e1",
    textTransform: "uppercase"
  },
  table: {
    width: "100%",
    minWidth: 1220,
    borderCollapse: "collapse"
  },
  tableCompact: {
    width: "100%",
    minWidth: 720,
    borderCollapse: "collapse"
  },
  th: {
    padding: "7px 8px",
    textAlign: "left",
    fontSize: 11,
    color: "#93c5fd",
    background: "#0b1220",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderBottom: "1px solid #1f2937",
    whiteSpace: "nowrap"
  },
  statusTh: {
    width: 34,
    minWidth: 34,
    textAlign: "center"
  },
  td: {
    padding: "8px",
    borderTop: "1px solid #1f2937",
    color: "#e5e7eb",
    verticalAlign: "top"
  },
  statusTd: {
    width: 34,
    minWidth: 34,
    textAlign: "center",
    verticalAlign: "middle"
  },
  cellTitle: {
    fontSize: 13,
    fontWeight: 600
  },
  cellMeta: {
    marginTop: 2,
    fontSize: 10,
    color: "#9ca3af"
  },
  thContent: {
    display: "grid",
    gap: 1,
    lineHeight: 1.1
  },
  thMeta: {
    fontSize: 10,
    color: "#60a5fa",
    fontWeight: 500
  },
  timeCell: {
    display: "grid",
    gap: 1
  },
  timeSub: {
    fontSize: 10,
    color: "#cbd5e1"
  },
  timeMeta: {
    fontSize: 10,
    color: "#9ca3af"
  },
  monoCell: {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    fontSize: 13
  }
};
