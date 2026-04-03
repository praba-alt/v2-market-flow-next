const NON_EVM_RPC_CONFIG = {
  solana: {
    aliases: new Set(["solana", "501424"]),
    allowedMethods: new Set([
      "getTokenAccountsByOwner",
      "getTokenAccountBalance",
      "getBalance",
      "getAccountInfo"
    ]),
    getRpcUrl() {
      if (process.env.SOLANA_RPC_URL) {
        return process.env.SOLANA_RPC_URL;
      }

      if (process.env.NEXT_ALCHEMY_KEY) {
        return `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_ALCHEMY_KEY}`;
      }

      if (process.env.NEXT_PUBLIC_SOLANA_RPC) {
        return process.env.NEXT_PUBLIC_SOLANA_RPC;
      }

      return "https://api.mainnet-beta.solana.com";
    }
  }
};

export function resolveNonEvmChain(chainOrId) {
  const raw = String(chainOrId || "").trim().toLowerCase();
  if (!raw) return "";

  for (const [chain, config] of Object.entries(NON_EVM_RPC_CONFIG)) {
    if (config.aliases.has(raw)) return chain;
  }

  return "";
}

export function getAllowedNonEvmMethods(chainOrId) {
  const chain = resolveNonEvmChain(chainOrId);
  return chain ? NON_EVM_RPC_CONFIG[chain].allowedMethods : new Set();
}

export function isAllowedNonEvmMethod(chainOrId, method) {
  return getAllowedNonEvmMethods(chainOrId).has(String(method || ""));
}

export function getNonEvmRpcUrl(chainOrId) {
  const chain = resolveNonEvmChain(chainOrId);
  if (!chain) return "";
  return NON_EVM_RPC_CONFIG[chain].getRpcUrl();
}

export async function callNonEvmRpc(chainOrId, method, params, timeoutMs = 15000) {
  const chain = resolveNonEvmChain(chainOrId);
  if (!chain) {
    throw new Error(`Unsupported non-EVM chain: ${chainOrId || "-"}`);
  }

  const methodName = String(method || "");
  if (!isAllowedNonEvmMethod(chain, methodName)) {
    throw new Error(`Unsupported ${chain} RPC method: ${methodName || "-"}`);
  }

  const rpcUrl = getNonEvmRpcUrl(chain);
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for non-EVM chain: ${chain}`);
  }

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: methodName,
      params: Array.isArray(params) ? params : []
    })
  });

  return res.json();
}
