# v2-market-flow-next

Next.js PoC for PinkSale market flow data extraction and contract enrichment.

## What this app now includes
- Existing V2 market-flow card/list pages
- New contract-based pools pipeline backed by SQLite:
  - Ingest source data from PinkSale (chain ID, pool address, token address)
  - Store normalized data in `tokens` and `pools` tables
  - Enrich EVM pools from ABI calls (`name`, `symbol`, `decimals`, `totalSupply`, `poolStates`)
  - Enrich non-EVM where supported (currently Solana path implemented)
  - ABI references centralized in `lib/abis/pinksale-launchpad-v2-abi.js`
- Contract pools UI page: `/contract-pools`
- API endpoints:
  - `POST /api/v2/contract-pools/sync`
  - `POST /api/v2/contract-pools/enrich`
  - `POST /api/v2/contract-pools/enrich-created-time`
  - `GET /api/v2/contract-pools/list`
  - `POST /api/v2/contract-pools/cron`
  - `POST /api/v2/contract-pools/cron-enrich`

## Install
```bash
npm install
```

## Environment setup
Create `.env.local` in project root.

Example `.env.local`:
```bash
# ---------------------------------
# Non-EVM helper (existing)
# ---------------------------------
NEXT_ALCHEMY_KEY=
NEXT_PUBLIC_SOLANA_RPC=https://api.mainnet-beta.solana.com

# ---------------------------------
# SQLite storage
# ---------------------------------
CONTRACT_POOLS_DB_PATH=./data/contract-pools.sqlite

# ---------------------------------
# Cron auth secret (recommended)
# ---------------------------------
CONTRACT_POOLS_CRON_SECRET=replace_with_strong_secret
# Optional Vercel fallback name:
# CRON_SECRET=replace_with_strong_secret

# ---------------------------------
# Fortuna-app compatible RPC naming
# (used first where applicable)
# ---------------------------------
ETHEREUM_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
SOLANA_RPC=https://api.mainnet-beta.solana.com
BSC_RPC=https://bsc-dataseed.binance.org
RPC_ETH=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_POLYGON=https://polygon-rpc.com
RPC_ARBITRUM=https://arb1.arbitrum.io/rpc
RPC_BASE=https://mainnet.base.org

# ---------------------------------
# Optional per-chain EVM overrides
# ---------------------------------
ETHEREUM_RPC_URL=
CRONOS_RPC_URL=
BSC_RPC_URL=
SHIBARIUM_RPC_URL=
UNICHAIN_RPC_URL=
POLYGON_RPC_URL=
XLAYER_RPC_URL=
FANTOM_RPC_URL=
PULSECHAIN_RPC_URL=
CORE_RPC_URL=
DOGECHAIN_RPC_URL=
ALVEY_RPC_URL=
ZETACHAIN_RPC_URL=
BITROCK_RPC_URL=
BASE_RPC_URL=
ARBITRUM_RPC_URL=
AVALANCHE_RPC_URL=

# ---------------------------------
# Optional non-EVM overrides
# ---------------------------------
SUI_RPC=
SUI_RPC_URL=
TON_RPC=
TON_RPC_URL=

# ---------------------------------
# Optional explorer keys for
# contract-created-time enrichment
# ---------------------------------
ETHERSCAN_API_KEY=
BSCSCAN_API_KEY=
POLYGONSCAN_API_KEY=
ARBISCAN_API_KEY=
BASESCAN_API_KEY=
SNOWTRACE_API_KEY=
FTMSCAN_API_KEY=

# ---------------------------------
# Optional throttling knobs
# ---------------------------------
EVM_ENRICH_CALL_DELAY_MS=150
CREATED_TIME_CALL_DELAY_MS=200
ENRICH_PROGRESS_EVERY=100
```

Notes:
- For local PoC, you can keep only `ETHEREUM_RPC` + `SOLANA_RPC` and add more RPCs later.
- If PinkSale API is blocked by Cloudflare (403), sync supports snapshot fallback.

## Run
```bash
npm run dev
```

## Build
```bash
npm run build
```

## Local cron scripts
Run these from project root:

```bash
# Sync only
npm run cron:sync:local

# Enrich only
npm run cron:enrich:local

# Build + sync only
npm run build:cron:sync

# Build + enrich only
npm run build:cron:enrich

# Build + full flow (sync then enrich loop)
npm run build:cron
```

Notes:
- `cron:enrich:local` runs one enrich cycle.
- `build:cron` uses looped enrich until completion (or max loop cap).
- You can override queries/port using:
  - `CRON_RUN_PORT`
  - `CRON_SYNC_QUERY`
  - `CRON_ENRICH_QUERY`
  - `CRON_ENRICH_MAX_RUNS`

## Contract pools workflow
1. Open `/contract-pools`
2. Click `1) Sync from PinkSale`
3. Click `2) Enrich EVM ABI`
4. Review table rows and updated values

## Cron
- Configured in `vercel.json`:
  - `/api/v2/contract-pools/cron` for sync
  - `/api/v2/contract-pools/cron-enrich` for enrichment
- Use bearer secret auth with `CONTRACT_POOLS_CRON_SECRET`.

See full ops guide:
- [CRON_RUNBOOK.md](./CRON_RUNBOOK.md)

## SQLite schema
- `tokens`
  - `token_id`, `chain_id`, `token_address`, `name`, `symbol`, `decimals`, `total_supply`
- `pools`
  - `pool_id`, `chain_id`, `pool_address`, `token_id`, `source_state`, `total_raised`, `total_committed`, `total_volume_purchased`

Both tables are linked by `token_id`.
