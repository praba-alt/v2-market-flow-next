# Contract Pools Cron Runbook

## Purpose
Two cron endpoints are used:
1. Sync cron: fetches discovery data from PinkSale (`chainId`, `pool.address`, `token.address`)
2. Enrich cron: fetches contract-derived values (token/pool ABI + contract creation time)

Endpoint:
- `POST /api/v2/contract-pools/cron`
- `POST /api/v2/contract-pools/cron-enrich`

## Auth
Set one of:
- `CONTRACT_POOLS_CRON_SECRET`
- `CRON_SECRET` (fallback)

Pass it as:
- `Authorization: Bearer <secret>`
- or header `x-cron-secret: <secret>`

## Scheduled Execution
Configured in [`vercel.json`](/Users/macbook/Fortuna%20Project/contract-experiments/v2-market-flow-next/vercel.json):
- `*/30 * * * *` on `/api/v2/contract-pools/cron` (sync)
- `15,45 * * * *` on `/api/v2/contract-pools/cron-enrich` (enrich)

## Manual Trigger Examples
Local:
```bash
curl -X POST "http://127.0.0.1:3000/api/v2/contract-pools/cron" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"

curl -X POST "http://127.0.0.1:3000/api/v2/contract-pools/cron-enrich" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"
```

Production:
```bash
curl -X POST "https://<your-domain>/api/v2/contract-pools/cron" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"

curl -X POST "https://<your-domain>/api/v2/contract-pools/cron-enrich" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"
```

With custom controls:
```bash
curl -X POST "https://<your-domain>/api/v2/contract-pools/cron?syncMaxPages=3&syncPageSize=3000&skipExisting=true&syncSource=api&allowSnapshotFallback=true&runSync=true&runAbiEnrich=false&runCreatedTimeEnrich=false" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"

curl -X POST "https://<your-domain>/api/v2/contract-pools/cron-enrich?runAbiEnrich=true&enrichLimit=1000&onlyMissing=true&includeNonEvm=true&runCreatedTimeEnrich=true&createdTimeBatchSize=1000&createdTimeMaxBatches=all" \
  -H "Authorization: Bearer $CONTRACT_POOLS_CRON_SECRET"
```

## Query/Body Parameters
Sync cron (`/cron`):
- `runSync`: default `true`
- `runAbiEnrich`: default `false`
- `runCreatedTimeEnrich`: default `false`
- `syncSource`: `api` | `snapshot` (default `api`)
- `syncMaxPages`: default `5`
- `syncPageSize`: default `3000`
- `skipExisting`: default `true`
- `allowSnapshotFallback`: default `true`
- `syncSnapshotPath`: optional custom snapshot path

Enrich cron (`/cron-enrich`):
- `runAbiEnrich`: default `true`
- `enrichLimit`: default `1000`
- `onlyMissing`: default `true`
- `includeNonEvm`: default `true`
- `runCreatedTimeEnrich`: default `true`
- `createdTimeBatchSize`: default `1000`
- `createdTimeMaxBatches`: default `all`

## Expected Success Response
```json
{
  "ok": true,
  "startedAt": "...",
  "finishedAt": "...",
  "runSync": true,
  "runAbiEnrich": false,
  "runCreatedTimeEnrich": false,
  "sync": { "source": "api|snapshot", "...": "..." },
  "enrich": null,
  "enrichCreatedTime": null
}
```

## Common Failures and Fixes
1. `401 Unauthorized cron request`
- Secret missing or wrong.
- Ensure env secret is set and sent in header.

2. `409 Cron job is already running`
- Previous run still active.
- Wait and retry; this prevents overlap.

3. PinkSale API `403` / Cloudflare challenge
- Cron supports fallback to snapshot if `allowSnapshotFallback=true`.
- Ensure snapshot exists at `public/market-flow-snapshot.json` or set `syncSnapshotPath`.

4. EVM enrichment errors / provider network detection issues
- RPC URL may be invalid/rate-limited.
- Check Fortuna-compatible env vars (`ETHEREUM_RPC`, `BSC_RPC`, `RPC_POLYGON`, etc.) and `*_RPC_URL` overrides.

5. Non-EVM enrichment low/no updates
- Expected if chain is unsupported or method unavailable.
- Solana is implemented; Sui/TON RPC support depends on endpoint compatibility.

6. Contract created-time enrichment low/no updates
- Explorer API key may be missing or rate-limited.
- Configure explorer keys in `.env` (`BSCSCAN_API_KEY`, `ETHERSCAN_API_KEY`, etc.).

## Operational Checks
1. Hit list API:
```bash
curl "http://127.0.0.1:3000/api/v2/contract-pools/list?page=1&pageSize=5"
```
2. Confirm DB file exists:
- `data/contract-pools.sqlite`
3. Verify updates increase over time in:
- `rows[].token_updated_at`
- `rows[].pool_updated_at`
