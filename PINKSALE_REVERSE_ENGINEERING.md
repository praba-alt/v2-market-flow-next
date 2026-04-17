# PinkSale Reverse-Engineering Spec (EVM + Non-EVM)

## Scope
Use PinkSale only as a **discovery source** for:
- `chainId`
- `poolAddress`
- `tokenAddress`

Everything else should be enriched from contracts/accounts and cached in SQLite.

## Local Evidence Used
- `lib/contract-pools-service.js`
- `lib/pinksale-chains.js`
- `lib/non-evm-rpc.js`
- `lib/abis/pinksale-launchpad-v2-abi.js`
- `pages/api/pinksale-tokenomics.js`
- archived PinkSale chunks:
  - `../pinksale_chunks_all/2354-2a75227e3ae13242.js`
  - `../Launchpad List _ Pinksale_V2_files/2354-2a75227e3ae13242.js`
- compatibility references:
  - `../../fortuna-app/src/constants/rpc.ts`
  - `../../fortuna_data_importer/src/config/constants.js`

## Web Sources (Alternatives)
- Chain RPC alternatives: `https://chainid.network/chains.json`
- Shibarium docs (navigation available, direct path was 404 in scrape): `https://docs.shib.io/shibarium`
- Bitrock docs root: `https://docs.bit-rock.io/`

## Required Data Model

### Token table (contract-derived where possible)
- `chain_id`
- `token_address`
- `name` (`ERC20.name()`)
- `symbol` (`ERC20.symbol()`)
- `decimals` (`ERC20.decimals()`)
- `total_supply` (`ERC20.totalSupply()`)

### Pool table (contract-derived where possible)
- `chain_id`
- `pool_address`
- `token_id` (FK)
- `source_state` (`poolStates.state`)
- `start_time` (`poolSettings.startTime`)
- `end_time` (`poolSettings.endTime`)
- `finish_time` (`poolStates.finishTime`)
- `total_raised` (`poolStates.totalRaised`)
- `total_committed` (`poolStates.totalCommitted`)
- `total_volume_purchased` (`poolStates.totalVolumePurchased`)
- `liquidity_unlock_time` (`poolStates.liquidityUnlockTime`)
- `pool_details` (`poolStates.poolDetails`)
- `kyc_details` (`poolStates.kycDetails`)
- `currency_address` (`poolSettings.currency`)
- `presale_rate` (`poolSettings.rate`)
- `listing_rate` (`poolSettings.listingRate`)
- `total_selling_tokens` (`poolSettings.totalSellingTokens`)
- optional: `pool_type`, `soft_cap`, `hard_cap`, `min`, `max` (only if methods exist on that pool variant)

## EVM ABI Strategy (Recommended)

### Tier A: Always-safe reads
- ERC20:
  - `name()`
  - `symbol()`
  - `decimals()`
  - `totalSupply()`
- Launchpad core:
  - `poolSettings()`
  - `poolStates()`
  - `needCalculate()`
  - `calculationStage()`
  - `getContributorCount()`
  - `getFeeSettings()`
  - `owner()`, `factory()`, `router()`, `version()`

These calls are the most compatible across your local Fortuna ABI usage.

### Tier B: Variant-only reads (guarded)
- `poolType()`
- `softCap()`
- `hardCap()`
- `min()`
- `max()`

Do not treat these as required. Some pool contracts revert on these selectors.

### Why this split
Your current enricher calls `poolType/softCap/hardCap` unconditionally in parallel.  
When a method is missing on a pool variant, it reverts and causes noisy failures or partial updates.

## Non-EVM Layout Strategy

### Solana (chain `501424`)
Use RPC + account decoding:
- token supply:
  - `getTokenSupply(mint)`
- lock account:
  - `getAccountInfo(lockerPubkey, { encoding: "base64" })`

Known lock layout offsets from `pages/api/pinksale-tokenomics.js`:
- `lockDate: 144`
- `unlockDate: 152`
- `cycleSeconds: 160`
- `tgePercentBps: 164`
- `cycleReleasePercentBps: 166`
- `amount: 168`
- `unlockedAmount: 176`
- `titleLen: 184`
- `title: 188`

Also use Solana IDL signals found in archived PinkSale chunks (pool structs/events for fairlaunch/presale/subscription variants).

### Sui (chain `50104`)
Current practical reads:
- `suix_getCoinMetadata`
- `suix_getTotalSupply`

### TON (chain `-239`)
Current practical read:
- `getAddressInformation`

## EVM RPC URL Matrix (Primary + Fallback)

Use env var first, then fallback list by chain:

| Chain | ID | Primary | Fallbacks |
|---|---:|---|---|
| Shibarium | 109 | `https://rpc.shibrpc.com` | `https://www.shibrpc.com`, `https://shib.nownodes.io` |
| Unichain | 130 | `https://mainnet.unichain.org` | `https://unichain-rpc.publicnode.com` |
| X Layer | 196 | `https://rpc.xlayer.tech` | `https://xlayerrpc.okx.com` |
| Fantom | 250 | `https://rpc.ftm.tools` | `https://fantom-rpc.publicnode.com`, `https://fantom.drpc.org` |
| PulseChain | 369 | `https://rpc.pulsechain.com` | `https://pulsechain-rpc.publicnode.com` |
| Core | 1116 | `https://rpc.coredao.org` | `https://core.drpc.org`, `https://rpc-core.icecreamswap.com` |
| Dogechain | 2000 | `https://rpc.dogechain.dog` | `https://rpc01-sg.dogechain.dog`, `https://rpc.ankr.com/dogechain` |
| Alvey | 3797 | `https://elves-core1.alvey.io` | `https://elves-core2.alvey.io`, `https://elves-core3.alvey.io` |
| ZetaChain | 7000 | `https://zetachain-evm.blockpi.network/v1/rpc/public` | `https://zeta-chain.drpc.org`, `https://zetachain-mainnet.public.blastapi.io` |
| Bitrock | 7171 | `https://connect.bit-rock.io` | `https://brockrpc.io` |

Notes:
- If your default URL fails network detection, rotate per-chain through fallback list before marking the pool errored.
- Keep per-chain rate-limiting and a provider cache.

## Layout/ABI Inference from PinkSale Bundles

From archived V2 chunks, we can confirm PinkSale multi-variant architecture:
- create/read surfaces for:
  - `createPresale`
  - `createFairLaunch`
  - `createOverflow`
  - `createSubscription`
- factory/facet style deployment (`diamondCut`, facet selectors)
- rich tuple-based pool settings for each variant
- Solana program account structs for launchpad variants and events

Implication: a single strict ABI is not enough; use a core ABI + guarded optional methods.

## Alternatives to Reduce PinkSale API Dependence

### Primary path (recommended)
1. PinkSale discovery only (`chainId`, `poolAddress`, `tokenAddress`).
2. Enrich all token/pool fields from chain RPC.
3. Persist per-field timestamps (`last_checked_at`, `post_end_checked_at`, `dynamic_checked_at`).

### Long-term path (full independence)
Index pool creation directly from chain contracts:
- EVM: factory events (e.g., pool created events from known factory/facet addresses).
- Solana: program account/event indexing for pool creation.

This removes dependency on PinkSale list/full_info stability.

## Execution Guidance

1. Keep sync job lean:
- PinkSale -> insert only `chain/pool/token` (skip existing).

2. Enrich job:
- token contract first
- pool contract second
- guarded optional calls
- status-aware refresh:
  - upcoming/live: periodic
  - after `end_time`: one final refresh
  - ended/cancelled and post-end-checked: skip

3. On-demand details page:
- if critical pool fields missing, trigger single on-demand enrich before rendering.

