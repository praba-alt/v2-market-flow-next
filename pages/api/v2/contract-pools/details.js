import { getPoolByChainAndAddress } from '../../../../lib/contract-pools-db';
import { enrichPoolOnDemand } from '../../../../lib/contract-pools-service';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chainId = Number(req.query.chainId);
    const poolAddress = String(req.query.poolAddress || '');

    if (!Number.isFinite(chainId) || !poolAddress) {
      return res.status(400).json({ ok: false, error: 'chainId and poolAddress are required' });
    }

    let row = getPoolByChainAndAddress({ chainId, poolAddress });
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Pool not found' });
    }

    const lazyEnrich = String(req.query.lazyEnrich || 'true').toLowerCase() !== 'false';
    if (lazyEnrich) {
      await enrichPoolOnDemand({ chainId, poolAddress });
      row = getPoolByChainAndAddress({ chainId, poolAddress }) || row;
    }

    return res.status(200).json({ ok: true, row });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to fetch pool details'
    });
  }
}
