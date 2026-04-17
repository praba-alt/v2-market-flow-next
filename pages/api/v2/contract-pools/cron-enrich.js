import {
  enrichEvmContracts,
  enrichPoolCreatedTimes
} from '../../../../lib/contract-pools-service';

let cronEnrichRunning = false;
let lastCronEnrichRun = null;
let cronEnrichStartedAtMs = 0;
const CRON_ENRICH_LOCK_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.CRON_ENRICH_LOCK_MAX_AGE_MS || 2 * 60 * 60 * 1000)
);

function parseBoolean(value, defaultValue) {
  if (value == null) return defaultValue;
  const v = String(value).toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defaultValue;
}

function isAuthorized(req) {
  const secret = process.env.CONTRACT_POOLS_CRON_SECRET || process.env.CRON_SECRET;
  if (!secret) return true;

  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const xSecret = String(req.headers['x-cron-secret'] || '');
  const querySecret = String(req.query.secret || req.body?.secret || '');

  return bearer === secret || xSecret === secret || querySecret === secret;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const now = Date.now();
    const runningForMs =
      cronEnrichRunning && cronEnrichStartedAtMs > 0 ? now - cronEnrichStartedAtMs : 0;
    return res.status(200).json({
      ok: true,
      running: cronEnrichRunning,
      runningSince: lastCronEnrichRun,
      runningForMs,
      staleAfterMs: CRON_ENRICH_LOCK_MAX_AGE_MS
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
  }

  const forceUnlock = parseBoolean(req.query.forceUnlock ?? req.body?.forceUnlock, false);

  if (forceUnlock) {
    cronEnrichRunning = false;
    lastCronEnrichRun = null;
    cronEnrichStartedAtMs = 0;
  }

  if (
    cronEnrichRunning &&
    cronEnrichStartedAtMs > 0 &&
    Date.now() - cronEnrichStartedAtMs > CRON_ENRICH_LOCK_MAX_AGE_MS
  ) {
    cronEnrichRunning = false;
    lastCronEnrichRun = null;
    cronEnrichStartedAtMs = 0;
  }

  if (cronEnrichRunning) {
    return res.status(409).json({
      ok: false,
      error: 'Enrich cron job is already running',
      runningSince: lastCronEnrichRun,
      staleAfterMs: CRON_ENRICH_LOCK_MAX_AGE_MS
    });
  }

  const startedAt = new Date().toISOString();
  const runAbiEnrich = parseBoolean(req.query.runAbiEnrich ?? req.body?.runAbiEnrich, true);
  const runCreatedTimeEnrich = parseBoolean(
    req.query.runCreatedTimeEnrich ?? req.body?.runCreatedTimeEnrich,
    false
  );
  const enrichLimit = Number(req.query.enrichLimit || req.body?.enrichLimit || 1000);
  const enrichStrategy = String(
    req.query.enrichStrategy || req.body?.enrichStrategy || 'dynamic'
  ).toLowerCase();
  const minDynamicRecheckAgeSec = Number(
    req.query.minDynamicRecheckAgeSec ||
      req.body?.minDynamicRecheckAgeSec ||
      process.env.DYNAMIC_RECHECK_INTERVAL_SEC ||
      600
  );
  const onlyMissing = parseBoolean(req.query.onlyMissing ?? req.body?.onlyMissing, true);
  const includeNonEvm = parseBoolean(req.query.includeNonEvm ?? req.body?.includeNonEvm, true);
  const createdTimeBatchSize = Number(
    req.query.createdTimeBatchSize || req.body?.createdTimeBatchSize || 1000
  );
  const createdTimeMaxBatches =
    req.query.createdTimeMaxBatches ?? req.body?.createdTimeMaxBatches ?? 'all';

  cronEnrichRunning = true;
  lastCronEnrichRun = startedAt;
  cronEnrichStartedAtMs = Date.now();

  try {
    const enrichResult = runAbiEnrich
      ? await enrichEvmContracts({
          onlyMissing,
          strategy: enrichStrategy,
          limit: enrichLimit,
          includeNonEvm,
          minDynamicRecheckAgeSec
        })
      : null;

    const createdTimeEnrichResult = runCreatedTimeEnrich
      ? await enrichPoolCreatedTimes({
          batchSize: createdTimeBatchSize,
          maxBatches: createdTimeMaxBatches
        })
      : null;

    return res.status(200).json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      runAbiEnrich,
      runCreatedTimeEnrich,
      enrich: enrichResult,
      enrichCreatedTime: createdTimeEnrichResult
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      startedAt,
      failedAt: new Date().toISOString(),
      error: error?.message || 'Enrich cron job failed'
    });
  } finally {
    cronEnrichRunning = false;
    cronEnrichStartedAtMs = 0;
  }
}
