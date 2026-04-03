# PinkSale Tokenomics Extraction (Implementation Guide)

This guide explains how to extract tokenomics data from PinkSale with resilient fallbacks and render chart-ready segments.

## Objective
Generate tokenomics chart data with these buckets:
- `Presale`
- `Liquidity`
- `Unlocked`
- Optional detailed slices (vesting/lock titles) when available

## Endpoint templates

### 1) Pool full info
```txt
GET https://api.pinksale.finance/api/v1/pool/full_info?chainId=<CHAIN_ID>&poolAddress=<POOL_ADDRESS>
```

### 2) Lockers for token
```txt
GET https://api.pinksale.finance/api/v1/lockers?chain_id=<CHAIN_ID>&token=<TOKEN_ADDRESS>&limit=100&page=1&sortType=desc
```

### 3) Pinklock record page (for title/cycle)
```txt
GET https://www.pinksale.finance/pinklock/record/<LOCK_ID>?chain=<CHAIN_SLUG>
```

### 4) Proxy fallback (for blocked requests)
```txt
https://r.jina.ai/http://api.pinksale.finance/...
https://r.jina.ai/http://www.pinksale.finance/...
```

## Fetch flow (recommended)
1. Try direct `full_info`.
2. If blocked/fails, try proxied `full_info`.
3. If still failing, fetch launchpad HTML and parse `__NEXT_DATA__`.

## Direct request snippets

### Fetch JSON safely
```js
async function fetchText(url, headers = {}) {
  const res = await fetch(url, { method: "GET", headers, cache: "no-store" });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function parsePossiblyWrappedJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
  const iObj = s.indexOf("{");
  const iArr = s.indexOf("[");
  const i = iObj >= 0 && iArr >= 0 ? Math.min(iObj, iArr) : Math.max(iObj, iArr);
  if (i < 0) return null;
  return JSON.parse(s.slice(i));
}
```

### Parse `__NEXT_DATA__` from launchpad HTML fallback
```js
function parseNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end < 0) return null;
  return JSON.parse(html.slice(jsonStart, end).trim());
}
```

## Lock records enrichment
Use lockers list to get lock IDs, then parse each record page for title/cycle.

### Parse title/cycle from Pinklock markdown/text
```js
function parseCycleDays(text) {
  const m = String(text || "").match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function parsePinklockRecordMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/).map((x) => x.trim());

  function valueAfter(label) {
    const idx = lines.findIndex((x) => x.toLowerCase() === label.toLowerCase());
    if (idx < 0) return "";
    for (let i = idx + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || /^-+$/.test(line)) continue;
      return line;
    }
    return "";
  }

  const title = valueAfter("Title");
  const cycleText = valueAfter("Cycle");
  return { title: title || "", cycleDays: parseCycleDays(cycleText) };
}
```

### Derive current locked amount
```js
currentLockedAmount = max(amount - unlocked_amount, 0)
```

### Classify records
```js
if (cycleDays > 0) {
  // vesting record
} else {
  // non-vesting lock record
}
```

## Numeric helpers
```js
function toBigIntSafe(v) {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

function pow10(n) {
  let x = 1n;
  for (let i = 0; i < n; i += 1) x *= 10n;
  return x;
}

function pct6(value, total) {
  if (total <= 0n) return 0;
  return Number((value * 100000000n) / total) / 1000000;
}
```

## Tokenomics calculation

Inputs:
- `totalSupply`
- `risk.tokensForLiquidity`
- `risk.totalBurned`
- `risk.totalLocked`
- vesting/lock record totals
- sale params: `hardCap`, `rate`, `currency.decimals`, optional `totalSellingTokens`

### Presale amount
```js
if (totalSellingTokens > 0) {
  presale = totalSellingTokens;
} else if (hardCap > 0 && rate > 0) {
  presale = (hardCap * rate) / 10^currencyDecimals;
} else {
  presale = residual fallback;
}
```

### Unlocked amount
```js
unlocked = totalSupply - presale - liquidity - burned - locked - vesting;
if (unlocked < 0) unlocked = 0;
```

### Percentages
```js
presalePct   = pct6(presale, totalSupply)
liquidityPct = pct6(liquidity, totalSupply)
unlockedPct  = pct6(unlocked, totalSupply)
vestingPct   = pct6(totalVesting, totalSupply)
lockedPct    = pct6(totalLocked, totalSupply)
```

## Segment output contract (recommended)
Use chart-ready normalized output:

```js
[
  { label: "Presale", percent: <number>, amount: <string> },
  { label: "Liquidity", percent: <number>, amount: <string> },
  { label: "<Vesting Title A>", percent: <number>, amount: <string> },
  { label: "<Vesting Title B>", percent: <number>, amount: <string> },
  { label: "Unlocked", percent: <number>, amount: <string> },
  { label: "Burnt", percent: <number>, amount: <string> }
]
```

## Chart fallback strategy
When detailed record data is unavailable, render a basic chart:
- `Presale`
- `Liquidity`
- `Unlocked`

This keeps UI stable even if lock-title enrichment fails.

## Cache/staleness controls
Use both for freshest values:

```js
fetch(url, { cache: "no-store" })
```

```txt
? _ts=<Date.now()>
```

## Testing checklist
1. Confirm `full_info` works for selected chain/pool.
2. Confirm lockers endpoint returns docs for token.
3. Confirm record page parsing returns title/cycle.
4. Confirm percentages sum near 100% (small rounding drift is normal).
5. Confirm fallback chart appears when detailed extraction fails.

## Example query
```txt
/api/pinksale-tokenomics?chain=<CHAIN_SLUG>&chainId=<CHAIN_ID>&poolAddress=<POOL_ADDRESS>
```


## Donut chart example (minimal)

Given chart segments like:

```js
const segments = [
  { label: "Presale", percent: 28.6654, color: "#fd728f" },
  { label: "Liquidity", percent: 13.888386, color: "#049bff" },
  { label: "Team Vesting", percent: 12, color: "#39c7c2" },
  { label: "Advisors Vesting", percent: 3, color: "#57d3ad" },
  { label: "Unlocked", percent: 42.446213, color: "#ffcd56" }
];
```

Build a conic-gradient donut:

```js
function getConicGradient(segments) {
  const total = segments.reduce((sum, s) => sum + s.percent, 0);
  if (total <= 0) return "conic-gradient(#ddd 0% 100%)";

  let acc = 0;
  const stops = segments.map((s) => {
    const from = acc;
    const to = acc + (s.percent / total) * 100;
    acc = to;
    return `${s.color} ${from}% ${to}%`;
  });

  if (acc < 100) stops.push(`transparent ${acc}% 100%`);
  return `conic-gradient(${stops.join(", ")})`;
}
```

Render (HTML/CSS):

```html
<div class="donut" style="background: conic-gradient(...)">
  <div class="hole">TOKEN</div>
</div>
```

```css
.donut {
  width: 320px;
  height: 320px;
  border-radius: 50%;
  position: relative;
}
.hole {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: #020617;
  display: grid;
  place-items: center;
}
```

Legend mapping example:

```js
segments.map((s) => `${s.label}: ${s.percent.toFixed(2)}%`)
```

### Practical notes
- Normalize segment percentages before building gradient (sum to 100 for rendering).
- Keep original percentages for legend text.
- If detailed extraction fails, render fallback donut using only:
  - `Presale`
  - `Liquidity`
  - `Unlocked`
