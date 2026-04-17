import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { getChainName, PINKSALE_CHAIN_CONFIG } from '../lib/pinksale-chains';
import { isTemporarilyUnavailableChain } from '../lib/chain-availability';

const DEFAULT_PAGE_SIZE = 25;
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

function shortAddr(value, lead = 8, tail = 6) {
  if (!value || typeof value !== 'string') return '-';
  const trimmed = value.trim();
  if (trimmed.length <= lead + tail + 3) return trimmed;
  return `${trimmed.slice(0, lead)}...${trimmed.slice(-tail)}`;
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
    // Guardrail: if raised already exceeds hard cap and derived cap is larger, use derived.
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

function formatUnix(ts) {
  const n = toNum(ts);
  if (!n || n <= 0) return '-';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function deriveStatus(row) {
  const state = toNum(row?.source_state);
  const nowSec = Date.now() / 1000;
  const start = toNum(row?.start_time);
  const end = toNum(row?.end_time);

  if (state === 2) return 'Cancelled';
  if (state === 1) return 'Ended';
  if (start && nowSec < start) return 'Upcoming';
  if (end && nowSec >= end) return 'Ended';
  return 'Sale Live';
}

const statusColor = {
  'Sale Live': '#065f46',
  Ended: '#4b5563',
  Cancelled: '#b91c1c',
  Upcoming: '#a16207'
};

function getTargetText(row) {
  const { symbol, decimals } = resolveTargetCurrencyMeta(row);
  const targetRaw = resolveTargetRawFromPoolMath(row, decimals);
  return formatCurrencyAmount(targetRaw, decimals, symbol);
}

function getPoolTypeLabel(poolType) {
  const v = toNum(poolType);
  if (v === 1) return 'Fair Launch';
  if (v === 4) return 'Subscription';
  return 'Presale';
}

export default function ContractPoolsPage() {
  const router = useRouter();

  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [chainId, setChainId] = useState('');
  const [status, setStatus] = useState('');

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState('');
  const [lastActionInfo, setLastActionInfo] = useState(null);
  const [openingRowKey, setOpeningRowKey] = useState('');

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize)
    });

    if (search.trim()) params.set('search', search.trim());
    if (chainId.trim()) params.set('chainId', chainId.trim());
    if (status.trim()) params.set('status', status.trim());

    return `/api/v2/contract-pools/list?${params.toString()}`;
  }, [page, pageSize, search, chainId, status]);

  const chainOptions = useMemo(() => {
    return Object.values(PINKSALE_CHAIN_CONFIG)
      .filter((config) => !isTemporarilyUnavailableChain(config.chainId))
      .map((config) => ({
        value: String(config.chainId),
        label: `${config.name} (${config.chainId})`
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  async function goToDetails(row) {
    const rowKey = `${row?.chain_id}:${row?.pool_address}`;
    if (!rowKey || openingRowKey) return;

    const chain = encodeURIComponent(String(row?.chain_id ?? ''));
    const pool = encodeURIComponent(String(row?.pool_address || '').trim());
    if (!chain || !pool) return;
    setOpeningRowKey(rowKey);
    try {
      await router.push(`/contract-pools/${chain}/${pool}`);
    } catch {
      setOpeningRowKey('');
    }
  }

  async function loadRows() {
    setLoading(true);
    setError('');

    try {
      const res = await fetch(listUrl, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `List API failed (${res.status})`);
      }

      setRows(Array.isArray(json.rows) ? json.rows : []);
      setTotal(Number(json.total || 0));
      setTotalPages(Number(json.totalPages || 1));
    } catch (e) {
      setError(e?.message || String(e));
      setRows([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRows();
  }, [listUrl]);

  async function runSync() {
    setSyncing(true);
    setError('');
    try {
      const res = await fetch('/api/v2/contract-pools/sync?source=api&maxPages=all', {
        method: 'POST'
      });
      const json = await res.json();
      if (res.ok && json?.ok) {
        setLastActionInfo({ type: 'sync', payload: json });
        await loadRows();
        return;
      }

      const fallbackRes = await fetch(
        '/api/v2/contract-pools/sync?source=snapshot&maxPages=all',
        { method: 'POST' }
      );
      const fallbackJson = await fallbackRes.json();
      if (!fallbackRes.ok || !fallbackJson?.ok) {
        throw new Error(
          fallbackJson?.error ||
            json?.error ||
            `Sync failed (${fallbackRes.status})`
        );
      }
      setLastActionInfo({ type: 'sync-snapshot-fallback', payload: fallbackJson });
      await loadRows();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function runEnrich() {
    setEnriching(true);
    setError('');
    try {
      const res = await fetch(
        '/api/v2/contract-pools/enrich?strategy=dynamic&onlyMissing=false&limit=300',
        {
          method: 'POST'
        }
      );
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Enrich failed (${res.status})`);
      }
      setLastActionInfo({ type: 'enrich', payload: json });
      await loadRows();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setEnriching(false);
    }
  }

  return (
    <main style={{ width: '100%', margin: 0, padding: '14px 14px 22px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Contract Pools Listing</h1>
          <p style={{ marginTop: 4, color: '#6b7280', fontSize: 13 }}>
            Recent first. Compact grid. Fortuna-style listing fields.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={runSync}
            disabled={syncing || enriching}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', cursor: syncing || enriching ? 'not-allowed' : 'pointer', fontSize: 12 }}
          >
            {syncing ? 'Syncing...' : 'Sync PinkSale (All)'}
          </button>
          <button
            onClick={runEnrich}
            disabled={enriching || syncing}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #111827', background: '#111827', color: '#fff', cursor: enriching || syncing ? 'not-allowed' : 'pointer', fontSize: 12 }}
          >
            {enriching ? 'Enriching...' : 'Enrich ABI'}
          </button>
          <Link href="/" style={{ color: '#2563eb', textDecoration: 'none', fontSize: 12 }}>Main page</Link>
        </div>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          placeholder="Search token/pool/address"
          style={{ minWidth: 260, flex: 1, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
        />
        <select
          value={chainId}
          onChange={(e) => {
            setPage(1);
            setChainId(e.target.value);
          }}
          style={{ width: 190, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
        >
          <option value="">All chains</option>
          {chainOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          style={{ width: 140, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
        >
          <option value="">All status</option>
          <option value="live">Sale Live</option>
          <option value="upcoming">Upcoming</option>
          <option value="ended">Ended</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {error ? (
        <div style={{ marginTop: 10, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      {lastActionInfo ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#374151' }}>Last action output</summary>
          <pre style={{ marginTop: 6, background: '#f3f4f6', borderRadius: 8, padding: 10, overflowX: 'auto', fontSize: 11 }}>
            {JSON.stringify(lastActionInfo, null, 2)}
          </pre>
        </details>
      ) : null}

      <div style={{ marginTop: 8, color: '#374151', fontSize: 12 }}>
        Total rows: <strong>{total}</strong>
      </div>

      <div style={{ marginTop: 8, overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10, width: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1600, fontSize: 12, tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Status</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Coin</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Chain</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Target</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Start / End</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Sale Type</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Raised</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Pool</th>
              <th style={{ padding: 8, borderBottom: '1px solid #e5e7eb' }}>Token</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} style={{ padding: 14, textAlign: 'center' }}>Loading...</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: 14, textAlign: 'center' }}>No rows</td>
              </tr>
            ) : (
              rows.map((row) => {
                const status = deriveStatus(row);
                return (
                  <tr
                    key={`${row.chain_id}:${row.pool_address}`}
                    onClick={() => void goToDetails(row)}
                    style={{
                      cursor: openingRowKey ? 'progress' : 'pointer',
                      opacity: openingRowKey && openingRowKey !== `${row.chain_id}:${row.pool_address}` ? 0.65 : 1
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#f8fafc';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', color: statusColor[status] || '#111827', fontWeight: 600 }}>{status}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
                      <div style={{ fontWeight: 600 }}>{row.name || '-'}</div>
                      <div style={{ color: '#6b7280' }}>{row.symbol || '-'}</div>
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{getChainName(row.chain_id)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{getTargetText(row)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
                      <div>{formatUnix(row.start_time)}</div>
                      <div style={{ color: '#6b7280' }}>{formatUnix(row.end_time)}</div>
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{getPoolTypeLabel(row.pool_type)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
                      {(() => {
                        const { symbol, decimals } = resolveTargetCurrencyMeta(row);
                        return formatCurrencyAmount(row?.total_raised, decimals, symbol);
                      })()}
                    </td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} title={row.pool_address}>{shortAddr(row.pool_address)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {openingRowKey === `${row.chain_id}:${row.pool_address}` ? (
                        <span style={{ color: '#2563eb', fontFamily: 'inherit' }}>Opening...</span>
                      ) : (
                        <span title={row.token_address}>{shortAddr(row.token_address)}</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d1d5db', cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
        >
          Prev
        </button>
        <span>
          Page {page} / {totalPages}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #d1d5db', cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
        >
          Next
        </button>
      </div>
    </main>
  );
}
