import { enrichEvmContracts } from '../../../../lib/contract-pools-service';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const onlyMissingInput = req.query.onlyMissing ?? req.body?.onlyMissing;
    const onlyMissing =
      onlyMissingInput == null
        ? true
        : String(onlyMissingInput).toLowerCase() !== 'false';

    const limit = Number(req.query.limit || req.body?.limit || 200);
    const strategy = String(req.query.strategy || req.body?.strategy || 'missing').toLowerCase();
    const minDynamicRecheckAgeSec = Number(
      req.query.minDynamicRecheckAgeSec ||
        req.body?.minDynamicRecheckAgeSec ||
        process.env.DYNAMIC_RECHECK_INTERVAL_SEC ||
        600
    );
    const includeNonEvmInput = req.query.includeNonEvm ?? req.body?.includeNonEvm;
    const includeNonEvm =
      includeNonEvmInput == null
        ? true
        : String(includeNonEvmInput).toLowerCase() !== 'false';

    const result = await enrichEvmContracts({
      onlyMissing,
      strategy,
      limit,
      includeNonEvm,
      minDynamicRecheckAgeSec
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to enrich EVM contract data'
    });
  }
}
