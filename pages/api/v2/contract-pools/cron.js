import {
  enrichEvmContracts,
  enrichPoolCreatedTimes,
  syncContractsFromPinkSale
} from '../../../../lib/contract-pools-service';

let cronJobRunning = false;
let lastCronRun = null;
let cronStartedAtMs = 0;
const CRON_LOCK_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.CRON_LOCK_MAX_AGE_MS || 2 * 60 * 60 * 1000)
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
  if (!secret) return true; // allow in local/dev if secret is not configured

  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const xSecret = String(req.headers['x-cron-secret'] || '');
  const querySecret = String(req.query.secret || req.body?.secret || '');

  return bearer === secret || xSecret === secret || querySecret === secret;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const now = Date.now();
    const runningForMs = cronJobRunning && cronStartedAtMs > 0 ? now - cronStartedAtMs : 0;
    return res.status(200).json({
      ok: true,
      running: cronJobRunning,
      runningSince: lastCronRun,
      runningForMs,
      staleAfterMs: CRON_LOCK_MAX_AGE_MS
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
  }

  if (cronJobRunning && cronStartedAtMs > 0 && Date.now() - cronStartedAtMs > CRON_LOCK_MAX_AGE_MS) {
    cronJobRunning = false;
    lastCronRun = null;
    cronStartedAtMs = 0;
  }

  if (cronJobRunning) {
    return res.status(409).json({
      ok: false,
      error: 'Cron job is already running',
      runningSince: lastCronRun,
      staleAfterMs: CRON_LOCK_MAX_AGE_MS
    });
  }

  const startedAt = new Date().toISOString();
  const syncMaxPages = req.query.syncMaxPages ?? req.body?.syncMaxPages ?? 5;
  const syncPageSize = Number(req.query.syncPageSize || req.body?.syncPageSize || 3000);
  const enrichLimit = Number(req.query.enrichLimit || req.body?.enrichLimit || 500);
  const syncSource = String(req.query.syncSource || req.body?.syncSource || 'api').toLowerCase();
  const syncSnapshotPath = String(req.query.syncSnapshotPath || req.body?.syncSnapshotPath || '');
  const allowSnapshotFallback = parseBoolean(
    req.query.allowSnapshotFallback ?? req.body?.allowSnapshotFallback,
    true
  );
  const onlyMissing = parseBoolean(req.query.onlyMissing ?? req.body?.onlyMissing, true);
  const includeNonEvm = parseBoolean(req.query.includeNonEvm ?? req.body?.includeNonEvm, true);
  const skipExisting = parseBoolean(req.query.skipExisting ?? req.body?.skipExisting, true);
  const createdTimeBatchSize = Number(
    req.query.createdTimeBatchSize || req.body?.createdTimeBatchSize || 1000
  );
  const createdTimeMaxBatches =
    req.query.createdTimeMaxBatches ?? req.body?.createdTimeMaxBatches ?? 'all';
  const runSync = parseBoolean(req.query.runSync ?? req.body?.runSync, true);
  const runAbiEnrich = parseBoolean(req.query.runAbiEnrich ?? req.body?.runAbiEnrich, false);
  const runCreatedTimeEnrich = parseBoolean(
    req.query.runCreatedTimeEnrich ?? req.body?.runCreatedTimeEnrich,
    false
  );

  cronJobRunning = true;
  lastCronRun = startedAt;
  cronStartedAtMs = Date.now();

  try {
    let syncResult = null;
    if (runSync) {
      try {
        syncResult = await syncContractsFromPinkSale({
          maxPages: syncMaxPages,
          pageSize: syncPageSize,
          source: syncSource,
          snapshotPath: syncSnapshotPath,
          skipExisting
        });
      } catch (syncError) {
        if (!allowSnapshotFallback || syncSource === 'snapshot') {
          throw syncError;
        }

        syncResult = await syncContractsFromPinkSale({
          maxPages: syncMaxPages,
          pageSize: syncPageSize,
          source: 'snapshot',
          snapshotPath: syncSnapshotPath,
          skipExisting
        });
        syncResult.fallbackFrom = syncSource;
      }
    }

    const enrichResult = runAbiEnrich
      ? await enrichEvmContracts({
          onlyMissing,
          limit: enrichLimit,
          includeNonEvm
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
      runSync,
      runAbiEnrich,
      runCreatedTimeEnrich,
      sync: syncResult,
      enrich: enrichResult,
      enrichCreatedTime: createdTimeEnrichResult
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      startedAt,
      failedAt: new Date().toISOString(),
      error: error?.message || 'Cron job failed'
    });
  } finally {
    cronJobRunning = false;
    cronStartedAtMs = 0;
  }
}
