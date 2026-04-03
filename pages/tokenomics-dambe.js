import { useEffect, useMemo, useState } from "react";

const DEFAULT_CHAIN = "bsc";
const DEFAULT_POOL = "0x35C79c669a44dAC0c07Cee032b7ab84e3368F359";

const FIXED_COLORS = {
  Presale: "#fd728f",
  Liquidity: "#049bff",
  Unlocked: "#ffcd56",
  Burnt: "#96A1B0"
};

function hashLabel(input) {
  let h = 0;
  const s = String(input || "");
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
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
  const hash = hashLabel(label);
  const hue = hash % 360;
  const sat = 0.62;
  const light = 0.54;
  return hslToHex(hue, sat, light);
}

function fmtPct(v) {
  return `${Number(v || 0).toFixed(6).replace(/\.?0+$/, "")}%`;
}

function getConicGradient(stops) {
  if (!stops.length) return "conic-gradient(#ddd 0% 100%)";
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

export default function TokenomicsDambePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const qs = new URLSearchParams({
          chain: DEFAULT_CHAIN,
          poolAddress: DEFAULT_POOL,
          _ts: String(Date.now())
        });
        const res = await fetch(`/api/pinksale-tokenomics?${qs.toString()}`, {
          cache: "no-store"
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json?.error || `Request failed (${res.status})`);
        }
        if (!cancelled) setPayload(json);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const slices = useMemo(() => {
    const m = payload?.mappedTokenomics;
    if (!m) return [];
    const list = Array.isArray(m.chartSegments)
      ? m.chartSegments.map((x) => ({
          label: String(x.label || ""),
          value: Number(x.percent || 0)
        }))
      : [];
    return list.filter((x) => x.label && x.value > 0);
  }, [payload]);

  const colorByLabel = useMemo(() => {
    const out = {};
    for (const s of slices) {
      out[s.label] = colorForLabel(s.label);
    }
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

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>DAMBE Tokenomics (Live from PinkSale)</h1>
        <p style={styles.sub}>
          Source: PinkSale launchpad page JSON (`__NEXT_DATA__`) mapped with
          PinkSale tokenomics bucket logic.
        </p>

        {loading ? <p>Loading...</p> : null}
        {error ? <p style={styles.error}>{error}</p> : null}

        {!loading && !error && payload ? (
          <>
            <div style={styles.chartRow}>
              <div style={{ ...styles.donut, background: gradient }}>
                <div style={styles.hole}>
                  <div style={styles.symbol}>
                    {payload?.token?.symbol || "TOKEN"}
                  </div>
                </div>
              </div>

              <div style={styles.legend}>
                {slices.map((s) => (
                  <div key={s.label} style={styles.legendItem}>
                    <span
                      style={{
                        ...styles.swatch,
                        backgroundColor: colorByLabel[s.label] || "#bbb"
                      }}
                    />
                    <span style={styles.legendText}>
                      {s.label}: {fmtPct(s.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <pre style={styles.meta}>
{JSON.stringify(
  {
    source: payload.source?.url,
    fetchedAt: payload.source?.fetchedAt,
    poolAddress: payload.poolAddress,
    token: payload.token,
    mappedTokenomics: payload.mappedTokenomics
  },
  null,
  2
)}
            </pre>
          </>
        ) : null}
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#0b0f19",
    color: "#fff",
    padding: 24,
    fontFamily: "Arial, sans-serif"
  },
  card: {
    maxWidth: 1080,
    margin: "0 auto",
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 12,
    padding: 20
  },
  h1: { margin: 0, fontSize: 26 },
  sub: { marginTop: 8, color: "#9ca3af" },
  error: { color: "#f87171" },
  chartRow: {
    marginTop: 20,
    display: "flex",
    gap: 24,
    alignItems: "center",
    flexWrap: "wrap"
  },
  donut: {
    width: 360,
    height: 360,
    borderRadius: "50%",
    position: "relative",
    flexShrink: 0
  },
  hole: {
    position: "absolute",
    width: 180,
    height: 180,
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    borderRadius: "50%",
    background: "#0b0f19",
    display: "grid",
    placeItems: "center"
  },
  symbol: {
    fontSize: 42,
    fontWeight: 700,
    color: "#fd728f",
    letterSpacing: 1
  },
  legend: { minWidth: 280, display: "grid", gap: 10 },
  legendItem: { display: "flex", gap: 10, alignItems: "center" },
  swatch: { width: 14, height: 14, borderRadius: 3, display: "inline-block" },
  legendText: { color: "#e5e7eb" },
  meta: {
    marginTop: 20,
    background: "#0b1220",
    color: "#9ca3af",
    border: "1px solid #1f2937",
    borderRadius: 8,
    padding: 12,
    overflowX: "auto",
    fontSize: 12,
    lineHeight: 1.4
  }
};
