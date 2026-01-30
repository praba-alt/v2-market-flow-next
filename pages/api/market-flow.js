export default async function handler(req, res) {
  const TARGET_BASE =
    "https://api.pinksale.finance/api/v1/market-flow/list";

  const url = new URL(TARGET_BASE);

  // Forward all query params to the upstream API.
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, v));
    } else {
      url.searchParams.append(key, value);
    }
  }

  try {
    const upstreamRes = await fetch(url.toString(), {
      method: "GET",
      // Do not forward cookies from the browser; let Cloudflare
      // treat this as a server request.
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    const text = await upstreamRes.text();

    res.status(upstreamRes.status);
    // Try to pass JSON through, but if Cloudflare returns HTML,
    // we just forward it as-is.
    const contentType =
      upstreamRes.headers.get("content-type") || "application/json";
    res.setHeader("Content-Type", contentType);
    res.send(text);
  } catch (err) {
    res
      .status(502)
      .json({ error: err && err.message ? err.message : String(err) });
  }
}

