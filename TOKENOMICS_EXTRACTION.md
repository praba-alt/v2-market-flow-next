# PinkSale Tokenomics Extraction (Implementation Guide)

This guide explains how to extract tokenomics data from PinkSale with resilient fallbacks, contract/RPC enrichment, and chart-ready output.

## Objective
Generate tokenomics chart data with these buckets:
- `Presale`
- `Liquidity`
- `Unlocked`
- Optional detailed slices from lock records when available
- Separate lock tables for:
  - `Liquidity Lock Records`
  - `Vesting Lock Records`
  - `Cliff Lock Records`

## Endpoint templates

### 1) Pool full info
```txt
GET https://api.pinksale.finance/api/v1/pool/full_info?chainId=<CHAIN_ID>&poolAddress=<POOL_ADDRESS>
```

### 2) Lockers for token
```txt
GET https://api.pinksale.finance/api/v1/lockers?chain_id=<CHAIN_ID>&token=<TOKEN_ADDRESS>&limit=100&page=1&sortType=desc
```

### 3) API proxy fallback (for blocked requests)
```txt
https://r.jina.ai/http://api.pinksale.finance/...
```

## Fetch flow (current recommended order)
1. Fetch pool bootstrap from PinkSale:
   - direct `full_info`
   - proxied `full_info`
2. Cache the bootstrap response and reuse it aggressively.
3. Use pool bootstrap as the seed for chain, token, sale params, liquidity lock metadata, and any pool-level locker pointer.
4. Fetch lock candidates:
   - first from pool info when available
   - then from lockers endpoint as supplemental enumeration
5. Resolve lock details from chain RPC / contract calls whenever possible.
6. If chain decode is incomplete, keep the generic fallback title rather than scraping pages.

## Source-of-truth rules
- PinkSale bootstrap is the source for:
  - sale params
  - pool type/state metadata
  - token/currency addresses
  - liquidity percentage
  - liquidity lock duration
  - pool-level locker pointers such as Solana `pool.locker`
- Chain RPC / contracts are the source for:
  - token decimals
  - total supply
  - lock amount
  - unlocked amount
  - current locked amount
  - TGE percent
  - cycle
  - cycle release percent
  - unlock timestamps
- If PinkSale text conflicts with a successful contract/account decode, prefer the contract/account decode.
- Do not emit a lock record row unless it resolved to meaningful lock data.

## RPC URL sources

### EVM RPC resolution
EVM RPC URLs are resolved from shared chain config.

Priority:
1. chain-specific env var
2. shared default public RPC URL in `lib/pinksale-chains.js`

Current EVM chain map:

| Chain ID | Chain | Env Var | Default RPC |
| --- | --- | --- | --- |
| `1` | Ethereum | `ETHEREUM_RPC_URL` | `https://ethereum.publicnode.com` |
| `25` | Cronos | `CRONOS_RPC_URL` | `https://evm.cronos.org` |
| `56` | BNB Chain | `BSC_RPC_URL` | `https://bsc-dataseed.binance.org/` |
| `97` | BNB Chain Testnet | `BSC_TESTNET_RPC_URL` | `https://data-seed-prebsc-1-s1.binance.org:8545/` |
| `109` | Shibarium | `SHIBARIUM_RPC_URL` | `https://rpc.shibrpc.com` |
| `130` | Unichain | `UNICHAIN_RPC_URL` | `https://mainnet.unichain.org` |
| `137` | Polygon | `POLYGON_RPC_URL` | `https://polygon-bor.publicnode.com` |
| `196` | X Layer | `XLAYER_RPC_URL` | `https://rpc.xlayer.tech` |
| `250` | Fantom | `FANTOM_RPC_URL` | `https://rpc.ftm.tools` |
| `369` | PulseChain | `PULSECHAIN_RPC_URL` | `https://rpc.pulsechain.com` |
| `1116` | Core | `CORE_RPC_URL` | `https://rpc.coredao.org` |
| `2000` | Dogechain | `DOGECHAIN_RPC_URL` | `https://rpc.dogechain.dog` |
| `3797` | Alvey | `ALVEY_RPC_URL` | `https://rpc.alvey.io` |
| `7000` | ZetaChain | `ZETACHAIN_RPC_URL` | `https://zetachain-evm.blockpi.network/v1/rpc/public` |
| `7171` | Bitrock | `BITROCK_RPC_URL` | `https://connect.bit-rock.io` |
| `8453` | Base | `BASE_RPC_URL` | `https://base.publicnode.com` |
| `42161` | Arbitrum | `ARBITRUM_RPC_URL` | `https://arbitrum-one.publicnode.com` |
| `43114` | Avalanche | `AVALANCHE_RPC_URL` | `https://api.avax.network/ext/bc/C/rpc` |

### Non-EVM RPC resolution
Current first-class non-EVM RPC support is Solana only.

Priority:
1. `SOLANA_RPC_URL`
2. `NEXT_ALCHEMY_KEY` mapped to `https://solana-mainnet.g.alchemy.com/v2/<KEY>`
3. `NEXT_PUBLIC_SOLANA_RPC`
4. `https://api.mainnet-beta.solana.com`

Allowed Solana RPC methods:
- `getTokenAccountsByOwner`
- `getTokenAccountBalance`
- `getTokenSupply`
- `getBalance`
- `getAccountInfo`

## Contract / RPC call reference

### EVM JSON-RPC transport
All EVM contract calls are standard `eth_call` requests:

```js
{
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [
    { to: CONTRACT_ADDRESS, data: CALL_DATA },
    "latest"
  ]
}
```

### EVM token metadata calls
Used to enrich token snapshot after PinkSale bootstrap.

Selectors:
- `decimals()` -> `0x313ce567`
- `totalSupply()` -> `0x18160ddd`

Example:
```js
eth_call({
  to: tokenAddress,
  data: "0x313ce567" // decimals()
}, "latest")

eth_call({
  to: tokenAddress,
  data: "0x18160ddd" // totalSupply()
}, "latest")
```

### EVM PinkLock calls
Used to resolve lock detail truth on supported EVM chains.

Selector:
- `getLockById(uint256)` -> `0x08f12470`

Call-data construction:
```js
const data = "0x08f12470" + lockIdHexPaddedTo32Bytes;
```

Request:
```js
eth_call({
  to: pinkLockAddress,
  data
}, "latest")
```

Decoded fields used by the API:
- `amount`
- `lockDate`
- `tgeDate`
- `tgeBps`
- `cycle`
- `cycleBps`
- `unlockedAmount`
- `description`

Title resolution:
- decode `description` JSON
- prefer `title`
- support PinkSale short key `l`
- otherwise fall back to:
  - `Manual Liquidity Lock`
  - `Lock <id>`

### Solana RPC calls

#### Token supply
Used for mint `decimals` and `totalSupply`.

```js
{
  jsonrpc: "2.0",
  id: 1,
  method: "getTokenSupply",
  params: [mintAddress]
}
```

#### Locker account decode
Used to resolve Solana lock records from `pool.locker` or locker API pubkeys.

```js
{
  jsonrpc: "2.0",
  id: 1,
  method: "getAccountInfo",
  params: [lockerPubkey, { encoding: "base64" }]
}
```

Decoded fields used by the API:
- `lockDate`
- `unlockDate`
- `cycleSeconds`
- `tgePercentBps`
- `cycleReleasePercentBps`
- `amount`
- `unlockedAmount`
- `title`

## PinkLock contract mapping
PinkLock addresses are mapped per EVM chain inside the API.

The handler chooses a contract address by:
1. chain id
2. explicit `lock_version` when available
3. fallback heuristic for high lock ids that belong to v3

This means:
- `lockers` API helps enumerate `lock_id`
- contract call provides the actual lock fields

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

## Lock records enrichment
Use a pool-info-first discovery order, then enrich with chain RPC.

### Discovery order
1. Start from pool bootstrap:
   - `pool.locker` for Solana pools
   - `liquidityLockDuration` / `risk.lpLockDays` for synthetic auto-liquidity records
2. Merge in lockers endpoint docs:
   - `lock_id`
   - `solana_details.locker_pubkey`
   - `amount`
   - `unlocked_amount`
   - `lock_date`
   - `expired`
   - `lock_version`
3. Deduplicate candidates by chain + `lockerPubkey` or chain + `lockId`.

### Candidate merge rules
```js
pool info            -> seed candidates first
lockers endpoint     -> supplemental ids, amounts, title hints
PinkLock contract    -> preferred EVM detail source
Solana account decode-> preferred Solana detail source
generic title        -> fallback only
```

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

### Generic title handling
- Generic titles are not enough on their own:
  - `Lock <id>`
  - `Liquidity lock`
- For non-liquidity records, generic titles should not override a more specific contract/account title.
- If the decoded title is still the generic liquidity label, display `Manual Liquidity Lock`.
- If no better title is available, `Lock <id>` is acceptable.

### EVM detail resolution
Use PinkLock `getLockById(lockId)` where chain support exists.

Resolved fields:
- `amount`
- `lockDate`
- `tgeDate`
- `tgeBps`
- `cycle`
- `cycleBps`
- `unlockedAmount`
- `description`

Decode `description` as JSON and support PinkSale short-key metadata:
```js
function extractPinklockTitle(description) {
  const parsed = JSON.parse(description);
  if (typeof parsed.title === "string") return parsed.title.trim();
  if (typeof parsed.l === "string") return parsed.l.trim(); // PinkSale short key
  return "";
}
```

### Solana detail resolution
Use Solana account decode when a locker pubkey is available.

Resolved fields:
- `lockDate`
- `unlockDate`
- `cycleSeconds`
- `tgePercentBps`
- `cycleReleasePercentBps`
- `amount`
- `unlockedAmount`
- `title`

### Derive current locked amount
```js
currentLockedAmount = max(amount - unlocked_amount, 0)
```

### Classify records
```js
if (cycleValue > 0 || tgePercent > 0 || cycleReleasePercent > 0) {
  // vesting record
} else {
  // cliff / one-time unlock record
}
```

### Liquidity lock rules
- Build a synthetic `Auto Listing Liquidity` record from sale params when:
  - liquidity token amount is known
  - `liquidityLockDuration > 0`
  - LP is not burned
- Unlock time base:
  - prefer `finishTime`
  - else `endTime`
  - else `claimTime`
- If `finishTime` is not available and `endTime` / `claimTime` is used, mark unlock time as estimated.
- If LP is burned, suppress liquidity lock status and synthetic liquidity lock record.

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
- resolved lock records

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

### Detailed allocation slices
- Use lock records to split locked/unlocked allocation slices.
- Labels should be normalized to:
  - `<Title> (Locked)`
  - `<Title> (Unlocked)`
- Presale should remain a plain `Presale` slice.
- Liquidity gets lock status only when a liquidity lock or safe liquidity state is actually known.

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
  { label: "<Allocation Title> (Locked)", percent: <number>, amount: <string> },
  { label: "<Allocation Title> (Unlocked)", percent: <number>, amount: <string> },
  { label: "Unlocked", percent: <number>, amount: <string> },
  { label: "Burnt", percent: <number>, amount: <string> }
]
```

### API response contract
Recommended response structure:
```js
{
  source: {
    mode: "api-direct" | "api-proxied",
    cacheStatus: "miss" | "fresh" | "refreshed" | "stale",
    lockersMode: "api-direct" | "api-proxied" | null,
    lockersCacheStatus: "miss" | "fresh" | "refreshed" | "stale" | null,
    onChainTokenSource: "rpc" | null
  },
  token: { address, symbol, name, decimals },
  mappedTokenomics: {
    chartSegments: [...],
    liquidityLockRecords: [...],
    vestingRecords: [...],
    lockRecords: [...]
  },
  rawRiskDetails,
  lockRecords
}
```

## Chart fallback strategy
When detailed record data is unavailable, render a basic chart:
- `Presale`
- `Liquidity`
- `Unlocked`

This keeps UI stable even if lock-title enrichment fails.

For non-EVM or degraded cases:
- if detailed chart segments are unavailable, use risk/basic chart fallback
- if lock records are unresolved, show no lock rows rather than placeholder junk rows

## Cache/staleness controls
Use both for freshest values:

```js
fetch(url, { cache: "no-store" })
```

```txt
? _ts=<Date.now()>
```

Current cache strategy:
- pool bootstrap cache: long TTL, stale fallback allowed
- lockers bootstrap cache: medium TTL, stale fallback allowed
- on-chain token snapshot: fetch on request

Design goal:
- minimize repeated PinkSale hits
- allow stale PinkSale bootstrap when upstream is flaky
- keep lock math fresh from RPC where possible

## Testing checklist
1. Confirm `full_info` works for selected chain/pool.
2. Confirm token decimals / total supply can be enriched from RPC.
3. Confirm pool-info lock hints are used first:
   - Solana `pool.locker`
   - liquidity lock duration
4. Confirm lockers endpoint only supplements candidate discovery.
5. Confirm EVM `getLockById` returns title/amount/TGE/cycle/unlocked fields where supported.
6. Confirm Solana account decode returns title/amount/TGE/cycle/unlocked fields where supported.
7. Confirm generic titles are normalized:
   - `Manual Liquidity Lock` for generic liquidity descriptions
8. Confirm percentages sum near 100% (small rounding drift is normal).
9. Confirm fallback chart appears when detailed extraction fails.
10. Confirm no unresolved placeholder rows like `Lock 12345` leak into the UI unless no better title exists.

## Example query
```txt
/api/pinksale-tokenomics?chain=<CHAIN_SLUG>&chainId=<CHAIN_ID>&poolAddress=<POOL_ADDRESS>
```

## Chain notes
- EVM chains use chain-specific PinkLock contract mappings.
- Solana uses `pool.locker` and account decoding via non-EVM RPC.
- Non-EVM RPC is currently first-class for Solana only.
- TON / Sui / other non-EVM chains may have bootstrap coverage before deep lock decoding coverage.


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
