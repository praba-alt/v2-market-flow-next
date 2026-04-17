import Link from 'next/link';

import { getPoolByChainAndAddress } from '../../../lib/contract-pools-db';
import { enrichPoolOnDemand } from '../../../lib/contract-pools-service';
import { getChainName } from '../../../lib/pinksale-chains';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CHAIN_NATIVE_CURRENCY = {
  1: { symbol: 'ETH', decimals: 18 },
  25: { symbol: 'CRO', decimals: 18 },
  56: { symbol: 'BNB', decimals: 18 },
  130: { symbol: 'ETH', decimals: 18 },
  137: { symbol: 'MATIC', decimals: 18 },
  196: { symbol: 'OKB', decimals: 18 },
  250: { symbol: 'FTM', decimals: 18 },
  369: { symbol: 'PLS', decimals: 18 },
  1116: { symbol: 'CORE', decimals: 18 },
  2000: { symbol: 'DOGE', decimals: 18 },
  3797: { symbol: 'ALV', decimals: 18 },
  7000: { symbol: 'ZETA', decimals: 18 },
  7171: { symbol: 'BROCK', decimals: 18 },
  8453: { symbol: 'ETH', decimals: 18 },
  42161: { symbol: 'ETH', decimals: 18 },
  43114: { symbol: 'AVAX', decimals: 18 }
};

function shortAddr(value, lead = 10, tail = 8) {
  if (!value || typeof value !== 'string') return '-';
  const trimmed = value.trim();
  if (trimmed.length <= lead + tail + 3) return trimmed;
  return `${trimmed.slice(0, lead)}...${trimmed.slice(-tail)}`;
}

function formatUnix(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 'Not fetched';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return 'Not fetched';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatCompact(value) {
  const n = toNum(value);
  if (n == null) return '-';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return `${n.toFixed(2)}`;
}

function formatByDecimals(rawValue, decimalsValue) {
  if (rawValue == null || rawValue === '') return '-';
  const decimals = toNum(decimalsValue);
  if (decimals == null || decimals < 0 || decimals > 30) {
    return formatCompact(rawValue);
  }

  let normalized;
  try {
    normalized = BigInt(String(rawValue)).toString();
  } catch {
    return formatCompact(rawValue);
  }

  const negative = normalized.startsWith('-');
  const digits = negative ? normalized.slice(1) : normalized;
  const padded = digits.padStart(decimals + 1, '0');
  const splitAt = padded.length - decimals;
  const whole = padded.slice(0, splitAt).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(splitAt).replace(/0+$/, '').slice(0, 4);
  const amount = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${amount}` : amount;
}

function formatCurrencyAmount(rawValue, decimalsValue, symbol) {
  const amount = formatByDecimals(rawValue, decimalsValue);
  if (amount === '-') return '-';
  const normalizedSymbol = String(symbol || '').trim();
  return normalizedSymbol ? `${amount} ${normalizedSymbol}` : amount;
}

function toBigIntSafe(value) {
  if (value == null || value === '') return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function pow10(exp) {
  const n = Number(exp);
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  return BigInt(10) ** BigInt(Math.floor(n));
}

function resolveTargetCurrencyMeta(row) {
  const chainId = Number(row?.chain_id);
  const native = CHAIN_NATIVE_CURRENCY[chainId] || null;
  const currencyAddress = String(row?.currency_address || '').trim().toLowerCase();
  const isNativeCurrency = !currencyAddress || currencyAddress === ZERO_ADDRESS;

  let symbol = String(row?.currency_symbol || '').trim();
  let decimals = toNum(row?.currency_decimals);

  if (!symbol && native && isNativeCurrency) {
    symbol = native.symbol;
  }
  if ((decimals == null || decimals <= 0) && native && isNativeCurrency) {
    decimals = native.decimals;
  }

  return { symbol, decimals };
}

function resolveTargetRawFromPoolMath(row, currencyDecimals) {
  const hardCapRaw = toBigIntSafe(row?.hard_cap);
  const softCapRaw = toBigIntSafe(row?.soft_cap);
  const raisedRaw = toBigIntSafe(row?.total_raised);
  const totalSellingRaw = toBigIntSafe(row?.total_selling_tokens);
  const presaleRateRaw = toBigIntSafe(row?.presale_rate);
  const scale = pow10(currencyDecimals);

  let derivedRaw = null;
  if (
    totalSellingRaw != null &&
    totalSellingRaw > 0n &&
    presaleRateRaw != null &&
    presaleRateRaw > 0n &&
    scale != null
  ) {
    derivedRaw = (totalSellingRaw * scale) / presaleRateRaw;
  }

  if (hardCapRaw != null && hardCapRaw > 0n) {
    if (
      raisedRaw != null &&
      raisedRaw > hardCapRaw &&
      derivedRaw != null &&
      derivedRaw > hardCapRaw
    ) {
      return derivedRaw.toString();
    }
    return hardCapRaw.toString();
  }

  if (softCapRaw != null && softCapRaw > 0n) {
    return softCapRaw.toString();
  }

  return derivedRaw != null && derivedRaw > 0n ? derivedRaw.toString() : null;
}

function getPoolTypeLabel(poolType) {
  const v = Number(poolType);
  if (v === 1) return 'Fair Launch';
  if (v === 4) return 'Subscription';
  return 'Presale';
}

function Field({ label, value }) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, minHeight: 64 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827', wordBreak: 'break-word' }}>{value ?? '-'}</div>
    </div>
  );
}

export async function getServerSideProps({ params }) {
  const chainId = Number(params?.chainId);
  const poolAddress = String(params?.poolAddress || '').toLowerCase();

  if (!Number.isFinite(chainId) || !poolAddress) {
    return { notFound: true };
  }

  let row = getPoolByChainAndAddress({ chainId, poolAddress });
  if (!row) {
    return { notFound: true };
  }

  await enrichPoolOnDemand({ chainId, poolAddress });
  row = getPoolByChainAndAddress({ chainId, poolAddress }) || row;

  return {
    props: {
      row: JSON.parse(JSON.stringify(row))
    }
  };
}

export default function ContractPoolDetailsPage({ row }) {
  const { symbol: targetSymbol, decimals: targetDecimals } = resolveTargetCurrencyMeta(row);
  const targetRaw = resolveTargetRawFromPoolMath(row, targetDecimals);
  const targetDisplay = formatCurrencyAmount(
    targetRaw,
    targetDecimals,
    targetSymbol
  );
  const totalRaisedDisplay = formatCurrencyAmount(
    row?.total_raised,
    targetDecimals,
    targetSymbol
  );
  const softCapDisplay = formatCurrencyAmount(
    row?.soft_cap,
    targetDecimals,
    targetSymbol
  );

  return (
    <main style={{ width: '100%', padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Token / Pool Details</h1>
          <div style={{ marginTop: 4, color: '#6b7280', fontSize: 13 }}>
            {row?.name || '-'} ({row?.symbol || '-'}) | {getChainName(row?.chain_id)}
          </div>
        </div>
        <Link href="/contract-pools" style={{ color: '#2563eb', textDecoration: 'none', fontSize: 13 }}>
          Back to contract pools
        </Link>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Field label="Status (source)" value={row?.source_state ?? '-'} />
        <Field label="Sale Type" value={getPoolTypeLabel(row?.pool_type)} />
        <Field label="Chain" value={`${getChainName(row?.chain_id)} (${row?.chain_id})`} />
        <Field label="Target" value={targetDisplay} />
      </div>

      <h2 style={{ marginTop: 20, marginBottom: 8, fontSize: 16 }}>Token (Fortuna-style fields)</h2>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Field label="Token Address" value={row?.token_address || '-'} />
        <Field label="Token Address (raw)" value={row?.token_address_raw || '-'} />
        <Field label="Name" value={row?.name || '-'} />
        <Field label="Symbol" value={row?.symbol || '-'} />
        <Field label="Decimals" value={row?.decimals ?? '-'} />
        <Field label="Total Supply" value={row?.total_supply || '-'} />
        <Field label="Logo URL" value={row?.logo_url || '-'} />
        <Field label="Token Updated At" value={row?.token_updated_at || '-'} />
      </div>

      <h2 style={{ marginTop: 20, marginBottom: 8, fontSize: 16 }}>Pool (Fortuna-style fields)</h2>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Field label="Pool Address" value={row?.pool_address || '-'} />
        <Field label="Pool Address (raw)" value={row?.pool_address_raw || '-'} />
        <Field label="Pool Type" value={row?.pool_type ?? '-'} />
        <Field label="Currency Address" value={row?.currency_address || '-'} />
        <Field label="Currency Name" value={row?.currency_name || '-'} />
        <Field label="Currency Symbol" value={row?.currency_symbol || '-'} />
        <Field label="Currency Decimals" value={row?.currency_decimals ?? '-'} />
        <Field label="Currency Total Supply" value={row?.currency_total_supply || '-'} />
        <Field label="Min Buy" value={row?.min_buy || '-'} />
        <Field label="Max Buy" value={row?.max_buy || '-'} />
        <Field label="Fee Currency" value={row?.fee_currency || '-'} />
        <Field label="Fee Token" value={row?.fee_token || '-'} />
        <Field label="Presale Rate" value={row?.presale_rate || '-'} />
        <Field label="Listing Rate" value={row?.listing_rate || '-'} />
        <Field label="Soft Cap" value={softCapDisplay} />
        <Field label="Hard Cap" value={targetDisplay} />
        <Field label="Total Selling Tokens" value={row?.total_selling_tokens || '-'} />
        <Field label="Total Raised" value={totalRaisedDisplay} />
        <Field label="Total Raised USD" value={row?.total_raised_usd || '-'} />
        <Field label="Total Committed" value={row?.total_committed || '-'} />
        <Field label="Total Volume Purchased" value={row?.total_volume_purchased || '-'} />
        <Field label="Start Time" value={formatUnix(row?.start_time)} />
        <Field label="End Time" value={formatUnix(row?.end_time)} />
        <Field label="Public Sale Start" value={formatUnix(row?.public_sale_start_time)} />
        <Field label="Claim Time" value={formatUnix(row?.claim_time)} />
        <Field label="Finish Time (raw)" value={row?.finish_time || '-'} />
        <Field label="Liquidity Unlock (raw)" value={row?.liquidity_unlock_time || '-'} />
        <Field label="Liquidity %" value={row?.liquidity_percentage ?? '-'} />
        <Field label="Buyback %" value={row?.buyback_percentage ?? '-'} />
        <Field label="Initial Market Cap" value={row?.initial_market_cap || '-'} />
        <Field label="Contributor Count" value={row?.contributor_count ?? '-'} />
        <Field label="Pool Lock ID" value={row?.pool_lock_id || '-'} />
        <Field label="Pool Owner" value={row?.pool_owner || '-'} />
        <Field label="Pool Factory" value={row?.pool_factory || '-'} />
        <Field label="Pool Router" value={row?.pool_router || '-'} />
        <Field label="Pool Version" value={row?.pool_version ?? '-'} />
        <Field
          label="Need Calculate"
          value={
            row?.pool_need_calculate == null
              ? '-'
              : row.pool_need_calculate
                ? 'true'
                : 'false'
          }
        />
        <Field label="Calc Stage" value={row?.calc_stage ?? '-'} />
        <Field label="Calc Current Index" value={row?.calc_current_index || '-'} />
        <Field
          label="Calc Finished Allocating User Count"
          value={row?.calc_finished_allocating_user_count || '-'}
        />
        <Field
          label="Calc Distributable Raised"
          value={row?.calc_distributable_raised || '-'}
        />
        <Field
          label="Calc Excessive Allocations"
          value={row?.calc_excessive_allocations || '-'}
        />
        <Field
          label="Calc Temp Distributable Raised"
          value={row?.calc_temp_distributable_raised || '-'}
        />
        <Field
          label="Calc Temp Excessive Allocations"
          value={row?.calc_temp_excessive_allocations || '-'}
        />
        <Field label="Pool Updated At" value={row?.updated_at || '-'} />
        <Field label="Pool Indexed At (local DB)" value={row?.created_at || '-'} />
      </div>

      <h2 style={{ marginTop: 20, marginBottom: 8, fontSize: 16 }}>Text / Metadata</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        <Field label="Pool Details" value={row?.pool_details || '-'} />
        <Field label="KYC Details" value={row?.kyc_details || '-'} />
        <Field label="Metadata JSON" value={row?.metadata_json || '-'} />
      </div>

      <div style={{ marginTop: 16, padding: 10, border: '1px dashed #cbd5e1', borderRadius: 8, fontSize: 12, color: '#475569' }}>
        Missing values are expected in this PoC until contract-specific enrichment methods are expanded per chain/type.
      </div>
    </main>
  );
}
