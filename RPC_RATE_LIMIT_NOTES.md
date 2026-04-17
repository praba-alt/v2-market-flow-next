# RPC Rate Limit Notes (Cautious Defaults)

Date: 2026-04-16  
Source: empirical probe/enrich behavior in this workspace (not official provider SLAs).

## Temporarily unavailable chains (hidden + skipped)
- `250` Fantom
- `109` Shibarium
- `7171` Bitrock

## Enrichment delay defaults (per-chain)
Configured in `lib/chain-availability.js` via `getEvmEnrichDelayMs`:

- `1` Ethereum: `180ms`
- `25` Cronos: `220ms`
- `56` BNB: `180ms`
- `130` Unichain: `220ms`
- `137` Polygon: `180ms`
- `196` X Layer: `220ms`
- `369` PulseChain: `250ms`
- `1116` Core: `260ms`
- `2000` Dogechain: `260ms`
- `3797` Alvey: `300ms`
- `7000` ZetaChain: `350ms`
- `8453` Base: `170ms`
- `42161` Arbitrum: `170ms`
- `43114` Avalanche: `220ms`

Fallback (if no chain override): `EVM_ENRICH_CALL_DELAY_MS` (default `150ms`).

## Created-time enrichment delays (scan APIs + RPC)
Configured via `getCreatedTimeDelayMs`:

- `1/56/137/42161/8453`: `220ms`
- `250`: `300ms`
- `43114`: `260ms`

Fallback: `CREATED_TIME_CALL_DELAY_MS` (default `200ms`).

## Env overrides
Global:
- `EVM_ENRICH_CALL_DELAY_MS`
- `CREATED_TIME_CALL_DELAY_MS`

Per-chain:
- `EVM_ENRICH_DELAY_MS_<CHAIN_ID>`
- `CREATED_TIME_DELAY_MS_<CHAIN_ID>`

Examples:
- `EVM_ENRICH_DELAY_MS_56=250`
- `CREATED_TIME_DELAY_MS_43114=350`

## Cron strategy default
`run-cron-step.mjs` and `run-cron-after-build.mjs` now default to:
- `enrichStrategy=dynamic`

This avoids unnecessary refresh of final states and reduces RPC pressure.
