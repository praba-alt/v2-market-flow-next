import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.CONTRACT_POOLS_DB_PATH || path.join(DATA_DIR, 'contract-pools.sqlite');

let db;

function getColumnNames(database, tableName) {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((row) => row.name));
}

function ensureColumns(database, tableName, columnDefinitions) {
  const existing = getColumnNames(database, tableName);
  for (const def of columnDefinitions) {
    const [name] = def.trim().split(/\s+/);
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${def}`);
    }
  }
}

function ensureDb() {
  if (db) return db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      token_address TEXT NOT NULL,
      token_address_raw TEXT,
      name TEXT,
      symbol TEXT,
      decimals INTEGER,
      total_supply TEXT,
      logo_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id, token_address)
    );

    CREATE TABLE IF NOT EXISTS pools (
      pool_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      pool_address TEXT NOT NULL,
      pool_address_raw TEXT,
      token_id INTEGER NOT NULL,
      source_state INTEGER,
      pool_type INTEGER,
      min_buy TEXT,
      max_buy TEXT,
      currency_address TEXT,
      currency_name TEXT,
      currency_symbol TEXT,
      currency_decimals INTEGER,
      currency_total_supply TEXT,
      fee_currency TEXT,
      fee_token TEXT,
      presale_rate TEXT,
      listing_rate TEXT,
      soft_cap TEXT,
      hard_cap TEXT,
      total_selling_tokens TEXT,
      total_raised TEXT,
      total_raised_usd TEXT,
      total_committed TEXT,
      total_volume_purchased TEXT,
      start_time INTEGER,
      end_time INTEGER,
      public_sale_start_time INTEGER,
      finish_time TEXT,
      claim_time INTEGER,
      liquidity_unlock_time TEXT,
      liquidity_percentage REAL,
      buyback_percentage REAL,
      initial_market_cap TEXT,
      contributor_count INTEGER,
      pool_lock_id TEXT,
      pool_owner TEXT,
      pool_factory TEXT,
      pool_router TEXT,
      pool_version INTEGER,
      pool_need_calculate INTEGER,
      calc_stage INTEGER,
      calc_current_index TEXT,
      calc_finished_allocating_user_count TEXT,
      calc_distributable_raised TEXT,
      calc_excessive_allocations TEXT,
      calc_temp_distributable_raised TEXT,
      calc_temp_excessive_allocations TEXT,
      pool_details TEXT,
      kyc_details TEXT,
      social_score REAL,
      contract_score REAL,
      trust_score REAL,
      source_index INTEGER,
      contract_created_at INTEGER,
      post_end_checked_at INTEGER,
      dynamic_checked_at INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chain_id, pool_address),
      FOREIGN KEY(token_id) REFERENCES tokens(token_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_chain_addr ON tokens(chain_id, token_address);
    CREATE INDEX IF NOT EXISTS idx_pools_chain_addr ON pools(chain_id, pool_address);
    CREATE INDEX IF NOT EXISTS idx_pools_token_id ON pools(token_id);
  `);

  ensureColumns(db, 'tokens', [
    'logo_url TEXT'
  ]);

  ensureColumns(db, 'pools', [
    'pool_type INTEGER',
    'min_buy TEXT',
    'max_buy TEXT',
    'currency_address TEXT',
    'currency_name TEXT',
    'currency_symbol TEXT',
    'currency_decimals INTEGER',
    'currency_total_supply TEXT',
    'fee_currency TEXT',
    'fee_token TEXT',
    'presale_rate TEXT',
    'listing_rate TEXT',
    'soft_cap TEXT',
    'hard_cap TEXT',
    'total_selling_tokens TEXT',
    'total_raised_usd TEXT',
    'start_time INTEGER',
    'end_time INTEGER',
    'public_sale_start_time INTEGER',
    'claim_time INTEGER',
    'liquidity_percentage REAL',
    'buyback_percentage REAL',
    'initial_market_cap TEXT',
    'contributor_count INTEGER',
    'pool_lock_id TEXT',
    'pool_owner TEXT',
    'pool_factory TEXT',
    'pool_router TEXT',
    'pool_version INTEGER',
    'pool_need_calculate INTEGER',
    'calc_stage INTEGER',
    'calc_current_index TEXT',
    'calc_finished_allocating_user_count TEXT',
    'calc_distributable_raised TEXT',
    'calc_excessive_allocations TEXT',
    'calc_temp_distributable_raised TEXT',
    'calc_temp_excessive_allocations TEXT',
    'pool_details TEXT',
    'kyc_details TEXT',
    'social_score REAL',
    'contract_score REAL',
    'trust_score REAL',
    'source_index INTEGER',
    'contract_created_at INTEGER',
    'post_end_checked_at INTEGER',
    'dynamic_checked_at INTEGER',
    'metadata_json TEXT'
  ]);

  return db;
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function poolExists({ chainId, poolAddress }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  if (!Number.isFinite(Number(chainId)) || !normalized) return false;

  const row = database
    .prepare(
      `SELECT 1 AS ok FROM pools WHERE chain_id = ? AND pool_address = ? LIMIT 1`
    )
    .get(Number(chainId), normalized);

  return Boolean(row?.ok);
}

export function getDb() {
  return ensureDb();
}

export function upsertToken({
  chainId,
  tokenAddressRaw,
  name = null,
  symbol = null,
  decimals = null,
  totalSupply = null,
  logoUrl = null
}) {
  const database = ensureDb();
  const tokenAddress = normalizeAddress(tokenAddressRaw);
  if (!Number.isFinite(Number(chainId)) || !tokenAddress) return null;

  const upsertStmt = database.prepare(`
    INSERT INTO tokens (
      chain_id,
      token_address,
      token_address_raw,
      name,
      symbol,
      decimals,
      total_supply,
      logo_url,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chain_id, token_address)
    DO UPDATE SET
      token_address_raw = excluded.token_address_raw,
      name = COALESCE(excluded.name, tokens.name),
      symbol = COALESCE(excluded.symbol, tokens.symbol),
      decimals = COALESCE(excluded.decimals, tokens.decimals),
      total_supply = COALESCE(excluded.total_supply, tokens.total_supply),
      logo_url = COALESCE(excluded.logo_url, tokens.logo_url),
      updated_at = datetime('now')
  `);

  upsertStmt.run(
    Number(chainId),
    tokenAddress,
    tokenAddressRaw || tokenAddress,
    name,
    symbol,
    toNumberOrNull(decimals),
    totalSupply != null ? String(totalSupply) : null,
    logoUrl
  );

  return database
    .prepare('SELECT token_id, chain_id, token_address FROM tokens WHERE chain_id = ? AND token_address = ?')
    .get(Number(chainId), tokenAddress);
}

export function upsertPool({
  chainId,
  poolAddressRaw,
  tokenId,
  sourceState = null,
  poolType = null,
  currencyAddress = null,
  currencyName = null,
  currencySymbol = null,
  currencyDecimals = null,
  currencyTotalSupply = null,
  presaleRate = null,
  listingRate = null,
  softCap = null,
  hardCap = null,
  totalSellingTokens = null,
  totalRaised = null,
  totalRaisedUsd = null,
  totalCommitted = null,
  totalVolumePurchased = null,
  startTime = null,
  endTime = null,
  publicSaleStartTime = null,
  finishTime = null,
  claimTime = null,
  liquidityUnlockTime = null,
  liquidityPercentage = null,
  buybackPercentage = null,
  initialMarketCap = null,
  contributorCount = null,
  poolDetails = null,
  kycDetails = null,
  sourceIndex = null,
  contractCreatedAt = null,
  metadataJson = null
}) {
  const database = ensureDb();
  const poolAddress = normalizeAddress(poolAddressRaw);
  if (!Number.isFinite(Number(chainId)) || !poolAddress || !Number.isFinite(Number(tokenId))) {
    return null;
  }

  const upsertStmt = database.prepare(`
    INSERT INTO pools (
      chain_id,
      pool_address,
      pool_address_raw,
      token_id,
      source_state,
      pool_type,
      currency_address,
      currency_name,
      currency_symbol,
      currency_decimals,
      currency_total_supply,
      presale_rate,
      listing_rate,
      soft_cap,
      hard_cap,
      total_selling_tokens,
      total_raised,
      total_raised_usd,
      total_committed,
      total_volume_purchased,
      start_time,
      end_time,
      public_sale_start_time,
      finish_time,
      claim_time,
      liquidity_unlock_time,
      liquidity_percentage,
      buyback_percentage,
      initial_market_cap,
      contributor_count,
      pool_details,
      kyc_details,
      source_index,
      contract_created_at,
      metadata_json,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(chain_id, pool_address)
    DO UPDATE SET
      pool_address_raw = excluded.pool_address_raw,
      token_id = excluded.token_id,
      source_state = COALESCE(excluded.source_state, pools.source_state),
      pool_type = COALESCE(excluded.pool_type, pools.pool_type),
      currency_address = COALESCE(excluded.currency_address, pools.currency_address),
      currency_name = COALESCE(excluded.currency_name, pools.currency_name),
      currency_symbol = COALESCE(excluded.currency_symbol, pools.currency_symbol),
      currency_decimals = COALESCE(excluded.currency_decimals, pools.currency_decimals),
      currency_total_supply = COALESCE(excluded.currency_total_supply, pools.currency_total_supply),
      presale_rate = COALESCE(excluded.presale_rate, pools.presale_rate),
      listing_rate = COALESCE(excluded.listing_rate, pools.listing_rate),
      soft_cap = COALESCE(excluded.soft_cap, pools.soft_cap),
      hard_cap = COALESCE(excluded.hard_cap, pools.hard_cap),
      total_selling_tokens = COALESCE(excluded.total_selling_tokens, pools.total_selling_tokens),
      total_raised = COALESCE(excluded.total_raised, pools.total_raised),
      total_raised_usd = COALESCE(excluded.total_raised_usd, pools.total_raised_usd),
      total_committed = COALESCE(excluded.total_committed, pools.total_committed),
      total_volume_purchased = COALESCE(excluded.total_volume_purchased, pools.total_volume_purchased),
      start_time = COALESCE(excluded.start_time, pools.start_time),
      end_time = COALESCE(excluded.end_time, pools.end_time),
      public_sale_start_time = COALESCE(excluded.public_sale_start_time, pools.public_sale_start_time),
      finish_time = COALESCE(excluded.finish_time, pools.finish_time),
      claim_time = COALESCE(excluded.claim_time, pools.claim_time),
      liquidity_unlock_time = COALESCE(excluded.liquidity_unlock_time, pools.liquidity_unlock_time),
      liquidity_percentage = COALESCE(excluded.liquidity_percentage, pools.liquidity_percentage),
      buyback_percentage = COALESCE(excluded.buyback_percentage, pools.buyback_percentage),
      initial_market_cap = COALESCE(excluded.initial_market_cap, pools.initial_market_cap),
      contributor_count = COALESCE(excluded.contributor_count, pools.contributor_count),
      pool_details = COALESCE(excluded.pool_details, pools.pool_details),
      kyc_details = COALESCE(excluded.kyc_details, pools.kyc_details),
      source_index = COALESCE(excluded.source_index, pools.source_index),
      contract_created_at = COALESCE(excluded.contract_created_at, pools.contract_created_at),
      metadata_json = COALESCE(excluded.metadata_json, pools.metadata_json),
      updated_at = datetime('now')
  `);

  upsertStmt.run(
    Number(chainId),
    poolAddress,
    poolAddressRaw || poolAddress,
    Number(tokenId),
    toNumberOrNull(sourceState),
    toNumberOrNull(poolType),
    currencyAddress ? String(currencyAddress).toLowerCase() : null,
    currencyName,
    currencySymbol,
    toNumberOrNull(currencyDecimals),
    currencyTotalSupply != null ? String(currencyTotalSupply) : null,
    presaleRate != null ? String(presaleRate) : null,
    listingRate != null ? String(listingRate) : null,
    softCap != null ? String(softCap) : null,
    hardCap != null ? String(hardCap) : null,
    totalSellingTokens != null ? String(totalSellingTokens) : null,
    totalRaised != null ? String(totalRaised) : null,
    totalRaisedUsd != null ? String(totalRaisedUsd) : null,
    totalCommitted != null ? String(totalCommitted) : null,
    totalVolumePurchased != null ? String(totalVolumePurchased) : null,
    toNumberOrNull(startTime),
    toNumberOrNull(endTime),
    toNumberOrNull(publicSaleStartTime),
    finishTime != null ? String(finishTime) : null,
    toNumberOrNull(claimTime),
    liquidityUnlockTime != null ? String(liquidityUnlockTime) : null,
    liquidityPercentage != null ? Number(liquidityPercentage) : null,
    buybackPercentage != null ? Number(buybackPercentage) : null,
    initialMarketCap != null ? String(initialMarketCap) : null,
    toNumberOrNull(contributorCount),
    poolDetails,
    kycDetails,
    toNumberOrNull(sourceIndex),
    toNumberOrNull(contractCreatedAt),
    metadataJson
  );

  return database
    .prepare('SELECT pool_id, chain_id, pool_address, token_id FROM pools WHERE chain_id = ? AND pool_address = ?')
    .get(Number(chainId), poolAddress);
}

export function updatePoolContractCreatedAt({ chainId, poolAddress, contractCreatedAt }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  const createdAt = toNumberOrNull(contractCreatedAt);
  if (!Number.isFinite(Number(chainId)) || !normalized || !Number.isFinite(createdAt)) return;

  database
    .prepare(`
      UPDATE pools
      SET
        contract_created_at = ?,
        updated_at = datetime('now')
      WHERE chain_id = ? AND pool_address = ?
    `)
    .run(createdAt, Number(chainId), normalized);
}

export function updatePoolSourceIndex({ chainId, poolAddress, sourceIndex }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  const indexValue = toNumberOrNull(sourceIndex);
  if (!Number.isFinite(Number(chainId)) || !normalized || !Number.isFinite(indexValue)) return;

  database
    .prepare(`
      UPDATE pools
      SET
        source_index = ?,
        updated_at = datetime('now')
      WHERE chain_id = ? AND pool_address = ?
    `)
    .run(indexValue, Number(chainId), normalized);
}

export function markPoolPostEndChecked({ chainId, poolAddress, checkedAtSec }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  const checkedAt = toNumberOrNull(checkedAtSec);
  if (!Number.isFinite(Number(chainId)) || !normalized || !Number.isFinite(checkedAt)) return;

  database
    .prepare(`
      UPDATE pools
      SET
        post_end_checked_at = ?,
        updated_at = datetime('now')
      WHERE chain_id = ? AND pool_address = ?
    `)
    .run(checkedAt, Number(chainId), normalized);
}

export function markPoolDynamicChecked({ chainId, poolAddress, checkedAtSec }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  const checkedAt = toNumberOrNull(checkedAtSec);
  if (!Number.isFinite(Number(chainId)) || !normalized || !Number.isFinite(checkedAt)) return;

  database
    .prepare(`
      UPDATE pools
      SET
        dynamic_checked_at = ?,
        updated_at = datetime('now')
      WHERE chain_id = ? AND pool_address = ?
    `)
    .run(checkedAt, Number(chainId), normalized);
}

export function listPoolsMissingContractCreatedAt({ limit = 1000 }) {
  const database = ensureDb();
  const max = Math.min(5000, Math.max(1, Number(limit) || 1000));

  return database
    .prepare(`
      SELECT
        p.pool_id,
        p.chain_id,
        p.pool_address
      FROM pools p
      WHERE p.contract_created_at IS NULL OR p.contract_created_at <= 0
      ORDER BY p.pool_id ASC
      LIMIT ?
    `)
    .all(max);
}

export function updateTokenEnrichment({ chainId, tokenAddress, name, symbol, decimals, totalSupply }) {
  const database = ensureDb();
  const normalized = normalizeAddress(tokenAddress);
  if (!Number.isFinite(Number(chainId)) || !normalized) return;

  database
    .prepare(`
      UPDATE tokens
      SET
        name = COALESCE(?, name),
        symbol = COALESCE(?, symbol),
        decimals = COALESCE(?, decimals),
        total_supply = COALESCE(?, total_supply),
        updated_at = datetime('now')
      WHERE chain_id = ? AND token_address = ?
    `)
    .run(
      name ?? null,
      symbol ?? null,
      Number.isFinite(Number(decimals)) ? Number(decimals) : null,
      totalSupply != null ? String(totalSupply) : null,
      Number(chainId),
      normalized
    );
}

export function updatePoolEnrichment({
  chainId,
  poolAddress,
  sourceState,
  poolType,
  minBuy,
  maxBuy,
  currencyAddress,
  currencyName,
  currencySymbol,
  currencyDecimals,
  currencyTotalSupply,
  feeCurrency,
  feeToken,
  presaleRate,
  listingRate,
  softCap,
  hardCap,
  totalSellingTokens,
  totalRaised,
  totalRaisedUsd,
  totalCommitted,
  totalVolumePurchased,
  startTime,
  endTime,
  publicSaleStartTime,
  finishTime,
  claimTime,
  liquidityUnlockTime,
  liquidityPercentage,
  buybackPercentage,
  initialMarketCap,
  contributorCount,
  poolLockId,
  poolOwner,
  poolFactory,
  poolRouter,
  poolVersion,
  poolNeedCalculate,
  calcStage,
  calcCurrentIndex,
  calcFinishedAllocatingUserCount,
  calcDistributableRaised,
  calcExcessiveAllocations,
  calcTempDistributableRaised,
  calcTempExcessiveAllocations,
  poolDetails,
  kycDetails,
  metadataJson
}) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  if (!Number.isFinite(Number(chainId)) || !normalized) return;

  database
    .prepare(`
      UPDATE pools
      SET
        source_state = COALESCE(?, source_state),
        pool_type = COALESCE(?, pool_type),
        min_buy = COALESCE(?, min_buy),
        max_buy = COALESCE(?, max_buy),
        currency_address = COALESCE(?, currency_address),
        currency_name = COALESCE(?, currency_name),
        currency_symbol = COALESCE(?, currency_symbol),
        currency_decimals = COALESCE(?, currency_decimals),
        currency_total_supply = COALESCE(?, currency_total_supply),
        fee_currency = COALESCE(?, fee_currency),
        fee_token = COALESCE(?, fee_token),
        presale_rate = COALESCE(?, presale_rate),
        listing_rate = COALESCE(?, listing_rate),
        soft_cap = COALESCE(?, soft_cap),
        hard_cap = COALESCE(?, hard_cap),
        total_selling_tokens = COALESCE(?, total_selling_tokens),
        total_raised = COALESCE(?, total_raised),
        total_raised_usd = COALESCE(?, total_raised_usd),
        total_committed = COALESCE(?, total_committed),
        total_volume_purchased = COALESCE(?, total_volume_purchased),
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        public_sale_start_time = COALESCE(?, public_sale_start_time),
        finish_time = COALESCE(?, finish_time),
        claim_time = COALESCE(?, claim_time),
        liquidity_unlock_time = COALESCE(?, liquidity_unlock_time),
        liquidity_percentage = COALESCE(?, liquidity_percentage),
        buyback_percentage = COALESCE(?, buyback_percentage),
        initial_market_cap = COALESCE(?, initial_market_cap),
        contributor_count = COALESCE(?, contributor_count),
        pool_lock_id = COALESCE(?, pool_lock_id),
        pool_owner = COALESCE(?, pool_owner),
        pool_factory = COALESCE(?, pool_factory),
        pool_router = COALESCE(?, pool_router),
        pool_version = COALESCE(?, pool_version),
        pool_need_calculate = COALESCE(?, pool_need_calculate),
        calc_stage = COALESCE(?, calc_stage),
        calc_current_index = COALESCE(?, calc_current_index),
        calc_finished_allocating_user_count = COALESCE(?, calc_finished_allocating_user_count),
        calc_distributable_raised = COALESCE(?, calc_distributable_raised),
        calc_excessive_allocations = COALESCE(?, calc_excessive_allocations),
        calc_temp_distributable_raised = COALESCE(?, calc_temp_distributable_raised),
        calc_temp_excessive_allocations = COALESCE(?, calc_temp_excessive_allocations),
        pool_details = COALESCE(?, pool_details),
        kyc_details = COALESCE(?, kyc_details),
        metadata_json = COALESCE(?, metadata_json),
        updated_at = datetime('now')
      WHERE chain_id = ? AND pool_address = ?
    `)
    .run(
      Number.isFinite(Number(sourceState)) ? Number(sourceState) : null,
      Number.isFinite(Number(poolType)) ? Number(poolType) : null,
      minBuy != null ? String(minBuy) : null,
      maxBuy != null ? String(maxBuy) : null,
      currencyAddress ? String(currencyAddress).toLowerCase() : null,
      currencyName ?? null,
      currencySymbol ?? null,
      Number.isFinite(Number(currencyDecimals)) ? Number(currencyDecimals) : null,
      currencyTotalSupply != null ? String(currencyTotalSupply) : null,
      feeCurrency != null ? String(feeCurrency) : null,
      feeToken != null ? String(feeToken) : null,
      presaleRate != null ? String(presaleRate) : null,
      listingRate != null ? String(listingRate) : null,
      softCap != null ? String(softCap) : null,
      hardCap != null ? String(hardCap) : null,
      totalSellingTokens != null ? String(totalSellingTokens) : null,
      totalRaised ?? null,
      totalRaisedUsd != null ? String(totalRaisedUsd) : null,
      totalCommitted ?? null,
      totalVolumePurchased ?? null,
      Number.isFinite(Number(startTime)) ? Number(startTime) : null,
      Number.isFinite(Number(endTime)) ? Number(endTime) : null,
      Number.isFinite(Number(publicSaleStartTime)) ? Number(publicSaleStartTime) : null,
      finishTime ?? null,
      Number.isFinite(Number(claimTime)) ? Number(claimTime) : null,
      liquidityUnlockTime ?? null,
      Number.isFinite(Number(liquidityPercentage)) ? Number(liquidityPercentage) : null,
      Number.isFinite(Number(buybackPercentage)) ? Number(buybackPercentage) : null,
      initialMarketCap != null ? String(initialMarketCap) : null,
      Number.isFinite(Number(contributorCount)) ? Number(contributorCount) : null,
      poolLockId != null ? String(poolLockId) : null,
      poolOwner ? String(poolOwner).toLowerCase() : null,
      poolFactory ? String(poolFactory).toLowerCase() : null,
      poolRouter ? String(poolRouter).toLowerCase() : null,
      Number.isFinite(Number(poolVersion)) ? Number(poolVersion) : null,
      typeof poolNeedCalculate === 'boolean' ? (poolNeedCalculate ? 1 : 0) : null,
      Number.isFinite(Number(calcStage)) ? Number(calcStage) : null,
      calcCurrentIndex != null ? String(calcCurrentIndex) : null,
      calcFinishedAllocatingUserCount != null
        ? String(calcFinishedAllocatingUserCount)
        : null,
      calcDistributableRaised != null ? String(calcDistributableRaised) : null,
      calcExcessiveAllocations != null ? String(calcExcessiveAllocations) : null,
      calcTempDistributableRaised != null ? String(calcTempDistributableRaised) : null,
      calcTempExcessiveAllocations != null ? String(calcTempExcessiveAllocations) : null,
      poolDetails ?? null,
      kycDetails ?? null,
      metadataJson ?? null,
      Number(chainId),
      normalized
    );
}

export function listPools({
  page = 1,
  pageSize = 20,
  search = '',
  chainId = null,
  status = '',
  excludeChainIds = [],
  nowSec = Math.floor(Date.now() / 1000)
}) {
  const database = ensureDb();

  const limit = Math.min(300, Math.max(1, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const where = [];
  const params = [];

  if (chainId !== null && chainId !== undefined && Number.isFinite(Number(chainId))) {
    where.push('p.chain_id = ?');
    params.push(Number(chainId));
  }

  const excluded = Array.isArray(excludeChainIds)
    ? [...new Set(excludeChainIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))]
    : [];
  if (excluded.length) {
    where.push(`p.chain_id NOT IN (${excluded.map(() => '?').join(', ')})`);
    params.push(...excluded);
  }

  if (search && String(search).trim()) {
    const q = `%${String(search).trim().toLowerCase()}%`;
    where.push(`(
      lower(p.pool_address) LIKE ? OR
      lower(t.token_address) LIKE ? OR
      lower(COALESCE(t.name, '')) LIKE ? OR
      lower(COALESCE(t.symbol, '')) LIKE ?
    )`);
    params.push(q, q, q, q);
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'live') {
    where.push(`(
      COALESCE(p.source_state, 0) NOT IN (1, 2) AND
      (p.start_time IS NULL OR p.start_time <= ?) AND
      (p.end_time IS NULL OR p.end_time > ?)
    )`);
    params.push(nowSec, nowSec);
  } else if (normalizedStatus === 'upcoming') {
    where.push(`(
      COALESCE(p.source_state, 0) NOT IN (1, 2) AND
      p.start_time IS NOT NULL AND
      p.start_time > ?
    )`);
    params.push(nowSec);
  } else if (normalizedStatus === 'ended') {
    where.push(`(
      p.source_state = 1 OR
      (COALESCE(p.source_state, 0) != 2 AND p.end_time IS NOT NULL AND p.end_time <= ?)
    )`);
    params.push(nowSec);
  } else if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
    where.push(`p.source_state = 2`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = database
    .prepare(`
      SELECT COUNT(*) AS total
      FROM pools p
      JOIN tokens t ON t.token_id = p.token_id
      ${whereSql}
    `)
    .get(...params);

  const rows = database
    .prepare(`
      SELECT
        p.pool_id,
        p.chain_id,
        p.pool_address,
        p.pool_address_raw,
        p.source_state,
        p.pool_type,
        p.currency_address,
        p.currency_symbol,
        p.currency_decimals,
        p.presale_rate,
        p.listing_rate,
        p.soft_cap,
        p.hard_cap,
        p.total_selling_tokens,
        p.total_raised,
        p.total_raised_usd,
        p.total_committed,
        p.total_volume_purchased,
        p.start_time,
        p.end_time,
        p.public_sale_start_time,
        p.finish_time,
        p.claim_time,
        p.liquidity_unlock_time,
        p.liquidity_percentage,
        p.buyback_percentage,
        p.initial_market_cap,
        p.contributor_count,
        p.social_score,
        p.contract_score,
        p.trust_score,
        p.source_index,
        p.contract_created_at,
        p.pool_details,
        p.kyc_details,
        p.metadata_json,
        p.updated_at AS pool_updated_at,
        p.created_at AS pool_created_at,
        t.token_id,
        t.token_address,
        t.token_address_raw,
        t.name,
        t.symbol,
        t.decimals,
        t.total_supply,
        t.logo_url,
        t.updated_at AS token_updated_at
      FROM pools p
      JOIN tokens t ON t.token_id = p.token_id
      ${whereSql}
      ORDER BY
        CASE WHEN p.source_index IS NULL THEN 1 ELSE 0 END ASC,
        p.source_index ASC,
        p.created_at DESC,
        p.pool_id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  return {
    page: currentPage,
    pageSize: limit,
    total: Number(countRow?.total || 0),
    rows
  };
}

export function getPoolByChainAndAddress({ chainId, poolAddress }) {
  const database = ensureDb();
  const normalized = normalizeAddress(poolAddress);
  if (!Number.isFinite(Number(chainId)) || !normalized) return null;

  return database
    .prepare(`
      SELECT
        p.*,
        t.token_address,
        t.token_address_raw,
        t.name,
        t.symbol,
        t.decimals,
        t.total_supply,
        t.logo_url,
        t.updated_at AS token_updated_at
      FROM pools p
      JOIN tokens t ON t.token_id = p.token_id
      WHERE p.chain_id = ? AND p.pool_address = ?
      LIMIT 1
    `)
    .get(Number(chainId), normalized);
}

export function listPoolsForEnrichment({
  onlyMissing = true,
  strategy = 'missing',
  limit = 200,
  nowSec = Math.floor(Date.now() / 1000),
  excludeChainIds = [],
  minDynamicRecheckAgeSec = 600
}) {
  const database = ensureDb();
  const max = Math.min(1000, Math.max(1, Number(limit) || 200));
  const recheckAge = Math.max(0, Number(minDynamicRecheckAgeSec) || 600);
  const dynamicCutoff = nowSec - recheckAge;

  const missingTokenSql = `(t.name IS NULL OR t.symbol IS NULL OR t.decimals IS NULL OR t.total_supply IS NULL)`;
  const dynamicPoolSql = `(
    (
      COALESCE(p.source_state, 0) NOT IN (1, 2) AND
      (p.end_time IS NULL OR p.end_time = 0 OR p.end_time > ?) AND
      (p.dynamic_checked_at IS NULL OR p.dynamic_checked_at <= ?)
    )
    OR
    (
      p.end_time IS NOT NULL AND
      p.end_time > 0 AND
      p.end_time <= ? AND
      p.post_end_checked_at IS NULL
    )
  )`;

  const excluded = Array.isArray(excludeChainIds)
    ? [...new Set(excludeChainIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))]
    : [];

  const whereParts = [];
  const whereParams = [];

  if (excluded.length) {
    whereParts.push(`p.chain_id NOT IN (${excluded.map(() => '?').join(', ')})`);
    whereParams.push(...excluded);
  }

  let whereSql = '';
  let orderSql = 'ORDER BY p.pool_id DESC';
  if (strategy === 'dynamic') {
    whereParts.push(`(${dynamicPoolSql} OR ${missingTokenSql})`);
    orderSql = `
      ORDER BY
        CASE WHEN p.dynamic_checked_at IS NULL THEN 0 ELSE 1 END ASC,
        p.dynamic_checked_at ASC,
        p.pool_id DESC
    `;
    whereParams.push(nowSec, dynamicCutoff, nowSec);
  } else if (onlyMissing) {
    whereParts.push(missingTokenSql);
  }

  whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  return database
    .prepare(`
      SELECT
        p.pool_id,
        p.chain_id,
        p.pool_address,
        p.source_state,
        p.start_time,
        p.end_time,
        p.post_end_checked_at,
        p.dynamic_checked_at,
        t.token_id,
        t.token_address,
        t.name,
        t.symbol,
        t.decimals,
        t.total_supply
      FROM pools p
      JOIN tokens t ON t.token_id = p.token_id
      ${whereSql}
      ${orderSql}
      LIMIT ?
    `)
    .all(...whereParams, max);
}

export function dbMeta() {
  return {
    path: DB_PATH
  };
}
