import { enrichPoolCreatedTimes } from '../../../../lib/contract-pools-service';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const batchSize = Number(req.query.batchSize || req.body?.batchSize || 1000);
    const maxBatches = req.query.maxBatches ?? req.body?.maxBatches ?? 'all';

    const result = await enrichPoolCreatedTimes({
      batchSize,
      maxBatches
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to enrich pool contract created time'
    });
  }
}
