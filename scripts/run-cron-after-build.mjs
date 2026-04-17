import { spawn } from 'node:child_process';

const port = Number(process.env.CRON_RUN_PORT || 3010);
const baseUrl = process.env.CRON_BASE_URL || `http://127.0.0.1:${port}`;
const startupTimeoutMs = Number(process.env.CRON_STARTUP_TIMEOUT_MS || 30000);
const requestTimeoutMs = Number(process.env.CRON_REQUEST_TIMEOUT_MS || 1800000);
const requestRetries = Math.max(0, Number(process.env.CRON_REQUEST_RETRIES || 3));

const syncQuery =
  process.env.CRON_SYNC_QUERY ||
  'runSync=true&runAbiEnrich=false&runCreatedTimeEnrich=false&syncSource=snapshot&syncMaxPages=all&syncPageSize=3000&skipExisting=true';
const enrichQuery =
  process.env.CRON_ENRICH_QUERY ||
  'runAbiEnrich=true&enrichStrategy=dynamic&enrichLimit=1000&onlyMissing=false&includeNonEvm=true&runCreatedTimeEnrich=false';
const enrichMaxRuns = Number(process.env.CRON_ENRICH_MAX_RUNS || 200);

const secret = process.env.CONTRACT_POOLS_CRON_SECRET || process.env.CRON_SECRET || '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // Ignore while booting.
    }
    await sleep(500);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function postJson(url) {
  const controller = new AbortController();
  const useTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0;
  const timer = useTimeout ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;

  try {
    const headers = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 500)}`);
    }

    if (!res.ok || !json?.ok) {
      const error = new Error(`Request failed (${res.status}): ${JSON.stringify(json)}`);
      error.status = res.status;
      error.payload = json;
      throw error;
    }
    return json;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= requestRetries + 1; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`[cron-runner] Retry ${attempt - 1}/${requestRetries} for ${url}`);
      }
      return await postJson(url);
    } catch (error) {
      lastError = error;
      const isAlreadyRunning =
        Number(error?.status) === 409 &&
        /already running/i.test(String(error?.payload?.error || error?.message || ''));
      if (isAlreadyRunning) {
        const waitMs = 15000;
        console.log(`[cron-runner] Enrich already running. Waiting ${waitMs / 1000}s and retrying...`);
        await sleep(waitMs);
        attempt -= 1;
        continue;
      }

      if (attempt > requestRetries) break;
      const waitMs = Math.min(10000, 1000 * attempt);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function getPositiveIntFromQuery(queryString, key, fallback) {
  const params = new URLSearchParams(queryString);
  const raw = params.get(key);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
  console.log(`[cron-runner] Starting production server on port ${port}`);
  const server = spawn('npm', ['run', 'start', '--', '--port', String(port)], {
    stdio: 'inherit'
  });

  const stopServer = () => {
    if (!server.killed) {
      server.kill('SIGINT');
    }
  };

  process.on('SIGINT', () => {
    stopServer();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopServer();
    process.exit(143);
  });

  try {
    await waitForServerReady(`${baseUrl}/`, startupTimeoutMs);
    console.log('[cron-runner] Server is ready');

    const syncUrl = `${baseUrl}/api/v2/contract-pools/cron?${syncQuery}`;
    console.log(`[cron-runner] Running sync cron: ${syncUrl}`);
    const syncResult = await postJsonWithRetry(syncUrl);
    console.log('[cron-runner] Sync cron complete');
    console.log(
      JSON.stringify(
        {
          startedAt: syncResult.startedAt,
          finishedAt: syncResult.finishedAt,
          sync: syncResult.sync
        },
        null,
        2
      )
    );

    const enrichLimit = getPositiveIntFromQuery(enrichQuery, 'enrichLimit', 1000);
    let enrichRun = 0;
    let lastEnrichResult = null;

    while (enrichRun < enrichMaxRuns) {
      enrichRun += 1;
      const enrichUrl = `${baseUrl}/api/v2/contract-pools/cron-enrich?${enrichQuery}`;
      console.log(`[cron-runner] Running enrich cron ${enrichRun}/${enrichMaxRuns}: ${enrichUrl}`);
      const enrichResult = await postJsonWithRetry(enrichUrl);
      lastEnrichResult = enrichResult;

      const abiScanned = Number(enrichResult?.enrich?.scanned || 0);
      const remainingCreatedTime = Number(enrichResult?.enrichCreatedTime?.remainingMissing || 0);
      const abiDone = abiScanned < enrichLimit;
      const createdTimeDone = !enrichResult?.runCreatedTimeEnrich || remainingCreatedTime === 0;

      console.log(
        JSON.stringify(
          {
            run: enrichRun,
            startedAt: enrichResult.startedAt,
            finishedAt: enrichResult.finishedAt,
            abiScanned,
            remainingCreatedTime,
            abiDone,
            createdTimeDone
          },
          null,
          2
        )
      );

      if (abiDone && createdTimeDone) {
        break;
      }
    }

    console.log('[cron-runner] Enrich cron complete');
    if (lastEnrichResult) {
      console.log(
        JSON.stringify(
          {
            startedAt: lastEnrichResult.startedAt,
            finishedAt: lastEnrichResult.finishedAt,
            enrich: lastEnrichResult.enrich,
            enrichCreatedTime: lastEnrichResult.enrichCreatedTime
          },
          null,
          2
        )
      );
    }
  } finally {
    console.log('[cron-runner] Stopping server');
    stopServer();
    await sleep(1000);
  }
}

main().catch((error) => {
  console.error('[cron-runner] Failed:', error.message);
  process.exit(1);
});
