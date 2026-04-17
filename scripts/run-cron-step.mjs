import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const mode = String(process.argv[2] || '').trim().toLowerCase();
if (!['sync', 'enrich'].includes(mode)) {
  console.error('Usage: node scripts/run-cron-step.mjs <sync|enrich>');
  process.exit(1);
}

const port = Number(process.env.CRON_RUN_PORT || 3010);
const baseUrl = process.env.CRON_BASE_URL || `http://127.0.0.1:${port}`;
const startupTimeoutMs = Number(process.env.CRON_STARTUP_TIMEOUT_MS || 30000);
const requestTimeoutMs = Number(process.env.CRON_REQUEST_TIMEOUT_MS || 1800000);
const requestRetries = Math.max(0, Number(process.env.CRON_REQUEST_RETRIES || 3));
const maxAlreadyRunningWaits = Math.max(1, Number(process.env.CRON_ALREADY_RUNNING_MAX_WAITS || 8));
const autoBuildIfMissing =
  String(process.env.CRON_AUTO_BUILD_IF_MISSING || 'true').toLowerCase() !== 'false';
const secret = process.env.CONTRACT_POOLS_CRON_SECRET || process.env.CRON_SECRET || '';
const forceUnlockOnConflict =
  String(process.env.CRON_FORCE_UNLOCK_ON_CONFLICT || 'false').toLowerCase() === 'true';

const syncQuery =
  process.env.CRON_SYNC_QUERY ||
  'runSync=true&runAbiEnrich=false&runCreatedTimeEnrich=false&syncSource=snapshot&syncMaxPages=all&syncPageSize=3000&skipExisting=true';
const enrichQuery =
  process.env.CRON_ENRICH_QUERY ||
  'runAbiEnrich=true&enrichStrategy=dynamic&enrichLimit=1000&onlyMissing=false&includeNonEvm=true&runCreatedTimeEnrich=false';
const enrichMaxRuns = Number(process.env.CRON_ENRICH_MAX_RUNS || 200);

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
      // ignore while booting
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
    const json = JSON.parse(text);
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

async function getJson(url) {
  const headers = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) {
    const error = new Error(`GET failed (${res.status}): ${JSON.stringify(json)}`);
    error.status = res.status;
    error.payload = json;
    throw error;
  }
  return json;
}

async function postJsonWithRetry(url) {
  let lastError;
  let alreadyRunningWaits = 0;
  for (let attempt = 1; attempt <= requestRetries + 1; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`[cron-step] Retry ${attempt - 1}/${requestRetries} for ${url}`);
      }
      return await postJson(url);
    } catch (error) {
      lastError = error;
      const isAlreadyRunning =
        Number(error?.status) === 409 &&
        /already running/i.test(String(error?.payload?.error || error?.message || ''));
      if (isAlreadyRunning) {
        alreadyRunningWaits += 1;
        try {
          const statusUrl = `${baseUrl}/api/v2/contract-pools/cron-enrich`;
          const status = await getJson(statusUrl);
          const runningForSec = Math.floor(Number(status?.runningForMs || 0) / 1000);
          console.log(
            `[cron-step] Enrich lock status: running=${Boolean(status?.running)} runningFor=${runningForSec}s since=${status?.runningSince || '-'}`
          );
        } catch {
          // best-effort status log
        }

        if (alreadyRunningWaits > maxAlreadyRunningWaits) {
          if (forceUnlockOnConflict) {
            const unlockUrl = `${baseUrl}/api/v2/contract-pools/cron-enrich?forceUnlock=true&runAbiEnrich=false&runCreatedTimeEnrich=false`;
            console.log('[cron-step] Max lock waits reached. Forcing unlock once...');
            await postJson(unlockUrl);
            alreadyRunningWaits = 0;
            continue;
          }
          throw new Error(
            `Enrich lock did not clear after ${maxAlreadyRunningWaits} waits. Re-run with CRON_FORCE_UNLOCK_ON_CONFLICT=true if you want to force unlock.`
          );
        }

        const waitMs = 15000;
        console.log(`[cron-step] Enrich already running. Waiting ${waitMs / 1000}s and retrying...`);
        await sleep(waitMs);
        attempt -= 1; // keep retry budget for real transport failures
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
  const buildIdPath = path.join(process.cwd(), '.next', 'BUILD_ID');
  if (!existsSync(buildIdPath)) {
    if (!autoBuildIfMissing) {
      throw new Error(
        "No production build found (.next/BUILD_ID). Run 'npm run build' first or enable CRON_AUTO_BUILD_IF_MISSING."
      );
    }

    console.log('[cron-step] No build found. Running npm run build...');
    await new Promise((resolve, reject) => {
      const buildProc = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
      buildProc.on('error', reject);
      buildProc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Build failed with exit code ${code}`));
      });
    });
  }

  const server = spawn('npm', ['run', 'start', '--', '--port', String(port)], {
    stdio: 'inherit'
  });

  const stopServer = () => {
    if (!server.killed) server.kill('SIGINT');
  };

  try {
    await waitForServerReady(`${baseUrl}/`, startupTimeoutMs);

    if (mode === 'sync') {
      const url = `${baseUrl}/api/v2/contract-pools/cron?${syncQuery}`;
      console.log(`[cron-step] Running sync: ${url}`);
      const result = await postJsonWithRetry(url);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const enrichLimit = getPositiveIntFromQuery(enrichQuery, 'enrichLimit', 1000);
    let run = 0;
    let lastResult = null;

    if (forceUnlockOnConflict) {
      try {
        const statusUrl = `${baseUrl}/api/v2/contract-pools/cron-enrich`;
        const status = await getJson(statusUrl);
        if (status?.running) {
          const runningForSec = Math.floor(Number(status?.runningForMs || 0) / 1000);
          console.log(
            `[cron-step] Preflight lock detected. runningFor=${runningForSec}s since=${status?.runningSince || '-'}`
          );
          const unlockUrl = `${baseUrl}/api/v2/contract-pools/cron-enrich?forceUnlock=true&runAbiEnrich=false&runCreatedTimeEnrich=false`;
          await postJson(unlockUrl);
          console.log('[cron-step] Preflight force-unlock applied.');
        }
      } catch (error) {
        console.log(
          `[cron-step] Preflight force-unlock skipped: ${String(error?.message || error)}`
        );
      }
    }

    while (run < enrichMaxRuns) {
      run += 1;
      const url = `${baseUrl}/api/v2/contract-pools/cron-enrich?${enrichQuery}`;
      console.log(`[cron-step] Running enrich ${run}/${enrichMaxRuns}: ${url}`);
      console.log('[cron-step] Enrich request started (may take several minutes)...');
      const result = await postJsonWithRetry(url);
      lastResult = result;

      const abiScanned = Number(result?.enrich?.scanned || 0);
      const remainingCreatedTime = Number(result?.enrichCreatedTime?.remainingMissing || 0);
      const abiDone = abiScanned < enrichLimit;
      const createdTimeDone = !result?.runCreatedTimeEnrich || remainingCreatedTime === 0;

      console.log(
        JSON.stringify(
          {
            run,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            abiScanned,
            remainingCreatedTime,
            abiDone,
            createdTimeDone
          },
          null,
          2
        )
      );

      if (abiDone && createdTimeDone) break;
    }

    if (lastResult) {
      console.log(JSON.stringify(lastResult, null, 2));
    }
  } finally {
    stopServer();
    await sleep(1000);
  }
}

main().catch((error) => {
  console.error('[cron-step] Failed:', error.message);
  process.exit(1);
});
