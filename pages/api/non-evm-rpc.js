import {
  callNonEvmRpc,
  getAllowedNonEvmMethods,
  resolveNonEvmChain
} from "../../lib/non-evm-rpc";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }

  const chain = resolveNonEvmChain(payload?.chain || payload?.chainId || req.query.chain || req.query.chainId);
  if (!chain) {
    res.status(400).json({ error: "Unsupported non-EVM chain" });
    return;
  }

  const method = String(payload?.method || "");
  if (!getAllowedNonEvmMethods(chain).has(method)) {
    res.status(400).json({ error: `Unsupported ${chain} RPC method: ${method || "-"}` });
    return;
  }

  try {
    const response = await callNonEvmRpc(chain, method, payload?.params, 10000);
    res.status(200).json(response);
  } catch (err) {
    res.status(502).json({
      error: err && err.message ? err.message : String(err)
    });
  }
}
