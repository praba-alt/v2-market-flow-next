# RPC Call Report (Contract Enrichment)

This PoC now treats PinkSale as discovery-only (`chain_id`, `pool_address`, `token_address`) and enriches the rest from RPC calls.

Notes:
- Failing calls are intentionally ignored via `safeCall(..., null, ...)`.
- Missing/failed calls do not fail the whole pool; only available values are persisted.
- Contract-created-time enrichment is disabled by default (`runCreatedTimeEnrich=false`).

## Token Contract Calls (EVM)

| Stage | RPC/ABI Call | Writes to DB |
|---|---|---|
| `token.enrich`, `token.on_demand` | `name()` | `tokens.name` |
| `token.enrich`, `token.on_demand` | `symbol()` | `tokens.symbol` |
| `token.enrich`, `token.on_demand` | `decimals()` | `tokens.decimals` |
| `token.enrich`, `token.on_demand` | `totalSupply()` | `tokens.total_supply` |

## Pool Contract Calls (V2 Tuple Profile)

| Stage | RPC/ABI Call | Writes to DB |
|---|---|---|
| `pool.v2` | `poolStates()` | `source_state`, `finish_time`, `total_raised`, `total_committed`, `total_volume_purchased`, `liquidity_unlock_time`, `pool_lock_id`, `pool_details`, `kyc_details` |
| `pool.v2` | `poolSettings()` | `currency_address`, `start_time`, `end_time`, `presale_rate`, `listing_rate`, `total_selling_tokens` |
| `pool.v2` | `poolType()` | `pool_type` |
| `pool.v2` | `softCap()` | `soft_cap` |
| `pool.v2` | `hardCap()` | `hard_cap` |
| `pool.v2` | `min()` / `max()` | `min_buy`, `max_buy` |
| `pool.v2` | `initialMarketCap()` | `initial_market_cap` |
| `pool.v2` | `getContributorCount()` | `contributor_count` |
| `pool.v2` | `owner()` / `factory()` / `router()` | `pool_owner`, `pool_factory`, `pool_router` |
| `pool.v2` | `version()` | `pool_version` |
| `pool.v2` | `needCalculate()` | `pool_need_calculate` |
| `pool.v2` | `calculationStage()` | `calc_stage`, `calc_current_index`, `calc_finished_allocating_user_count`, `calc_distributable_raised`, `calc_excessive_allocations`, `calc_temp_distributable_raised`, `calc_temp_excessive_allocations` |
| `pool.v2` | `getFeeSettings()` | `fee_currency`, `fee_token` |

## Pool Contract Calls (Legacy Scalar Profile)

| Stage | RPC/ABI Call | Writes to DB |
|---|---|---|
| `pool.legacy` | `state()` | `source_state` |
| `pool.legacy` | `poolType()` | `pool_type` |
| `pool.legacy` | `currency()` | `currency_address` |
| `pool.legacy` | `startTime()` / `endTime()` | `start_time`, `end_time` |
| `pool.legacy` | `publicSaleStartTime()` / `claimTime()` | `public_sale_start_time`, `claim_time` |
| `pool.legacy` | `rate()` / `listingRate()` | `presale_rate`, `listing_rate` |
| `pool.legacy` | `softCap()` / `hardCap()` | `soft_cap`, `hard_cap` |
| `pool.legacy` | `min()` / `max()` | `min_buy`, `max_buy` |
| `pool.legacy` | `totalRaised()` / `totalCommitted()` / `totalVolumePurchased()` | `total_raised`, `total_committed`, `total_volume_purchased` |
| `pool.legacy` | `totalSellingTokens()` | `total_selling_tokens` |
| `pool.legacy` | `finishTime()` / `liquidityUnlockTime()` | `finish_time`, `liquidity_unlock_time` |
| `pool.legacy` | `liquidityPercentage()` / `liquidityPercent()` | `liquidity_percentage` |
| `pool.legacy` | `buybackPercentage()` | `buyback_percentage` |
| `pool.legacy` | `initialMarketCap()` | `initial_market_cap` |
| `pool.legacy` | `getContributorCount()` | `contributor_count` |
| `pool.legacy` | `owner()` / `factory()` / `router()` | `pool_owner`, `pool_factory`, `pool_router` |
| `pool.legacy` | `version()` | `pool_version` |
| `pool.legacy` | `needCalculate()` | `pool_need_calculate` |
| `pool.legacy` | `calculationStage()` | `calc_*` fields |
| `pool.legacy` | `getFeeSettings()` | `fee_currency`, `fee_token` |
| `pool.legacy` | `poolDetails()` / `kycDetails()` | `pool_details`, `kyc_details` |

## Target Currency Metadata (ERC20 of Pool Currency)

| Stage | RPC/ABI Call | Writes to DB |
|---|---|---|
| `currency` | `name()` / `symbol()` / `decimals()` / `totalSupply()` | `currency_name`, `currency_symbol`, `currency_decimals`, `currency_total_supply` |

## Non-EVM Calls (currently Solana enrich path)

| Stage | RPC Method | Writes to DB |
|---|---|---|
| `non_evm.solana` | `getTokenSupply` | `tokens.total_supply`, `tokens.decimals` |
| `non_evm.solana` | `getBalance` | `pools.total_raised` |

## Optional (Currently Disabled by Default)

| Stage | RPC/Source Call | Purpose |
|---|---|---|
| `created_time` | EVM `eth_getCode` binary search + scanner fallback | Derive `contract_created_at` |
