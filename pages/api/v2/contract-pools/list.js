import { listPools } from '../../../../lib/contract-pools-db';
import { TEMP_UNAVAILABLE_CHAIN_IDS } from '../../../../lib/chain-availability';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 20);
    const chainId = req.query.chainId != null ? Number(req.query.chainId) : null;
    const search = req.query.search ? String(req.query.search) : '';
    const status = req.query.status ? String(req.query.status) : '';

    const result = listPools({
      page,
      pageSize,
      chainId,
      search,
      status,
      excludeChainIds: TEMP_UNAVAILABLE_CHAIN_IDS
    });
    const totalPages = result.total > 0 ? Math.ceil(result.total / result.pageSize) : 1;

    return res.status(200).json({
      ok: true,
      ...result,
      totalPages
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to list contract pools'
    });
  }
}
