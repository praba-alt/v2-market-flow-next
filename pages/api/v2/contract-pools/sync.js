import { syncContractsFromPinkSale } from '../../../../lib/contract-pools-service';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const maxPages = req.query.maxPages ?? req.body?.maxPages ?? 5;
    const pageSize = Number(req.query.pageSize || req.body?.pageSize || 3000);
    const source = String(req.query.source || req.body?.source || 'api').toLowerCase();
    const snapshotPath = String(req.query.snapshotPath || req.body?.snapshotPath || '');
    const skipExistingRaw = req.query.skipExisting ?? req.body?.skipExisting;
    const skipExisting =
      skipExistingRaw == null
        ? true
        : String(skipExistingRaw).toLowerCase() !== 'false';
    const allowSnapshotFallbackRaw =
      req.query.allowSnapshotFallback ?? req.body?.allowSnapshotFallback;
    const allowSnapshotFallback =
      allowSnapshotFallbackRaw == null
        ? true
        : String(allowSnapshotFallbackRaw).toLowerCase() !== 'false';

    try {
      const result = await syncContractsFromPinkSale({
        maxPages,
        pageSize,
        source,
        snapshotPath,
        skipExisting
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (!allowSnapshotFallback || source === 'snapshot') {
        throw error;
      }

      // Fallback chain:
      // api -> headless -> snapshot
      // headless -> snapshot
      if (source === 'api') {
        try {
          const headless = await syncContractsFromPinkSale({
            maxPages,
            pageSize,
            source: 'headless',
            snapshotPath,
            skipExisting
          });
          return res.status(200).json({
            ok: true,
            fallbackFrom: 'api',
            fallbackReason: error?.message || 'API source failed',
            ...headless
          });
        } catch (headlessError) {
          const snapshot = await syncContractsFromPinkSale({
            maxPages,
            pageSize,
            source: 'snapshot',
            snapshotPath,
            skipExisting
          });
          return res.status(200).json({
            ok: true,
            fallbackFrom: 'api',
            fallbackReason:
              headlessError?.message || error?.message || 'API/headless failed',
            ...snapshot
          });
        }
      }

      const snapshot = await syncContractsFromPinkSale({
        maxPages,
        pageSize,
        source: 'snapshot',
        snapshotPath,
        skipExisting
      });
      return res.status(200).json({
        ok: true,
        fallbackFrom: source,
        fallbackReason: error?.message || 'Primary source failed',
        ...snapshot
      });
    }
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to sync contract pools from PinkSale',
      hint:
        'If PinkSale API returns 403 from Cloudflare, retry with source=snapshot using public/market-flow-snapshot.json.'
    });
  }
}
