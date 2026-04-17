const NON_EVM_RPC_CONFIG = {
  solana: {
    aliases: new Set(["solana", "501424"]),
    allowedMethods: new Set([
      "getTokenAccountsByOwner",
      "getTokenAccountBalance",
      "getTokenSupply",
      "getBalance",
      "getAccountInfo"
    ]),
    getRpcUrls() {
      const urls = [];

      if (process.env.SOLANA_RPC) {
        urls.push(process.env.SOLANA_RPC);
      }

      if (process.env.SOLANA_RPC_URL) {
        urls.push(process.env.SOLANA_RPC_URL);
      }

      urls.push("https://api.mainnet-beta.solana.com");
      return [...new Set(urls.filter(Boolean))];
    }
  },
  sui: {
    aliases: new Set(["sui", "50104"]),
    allowedMethods: new Set(["suix_getCoinMetadata", "suix_getTotalSupply"]),
    getRpcUrls() {
      const urls = [];
      if (process.env.SUI_RPC) urls.push(process.env.SUI_RPC);
      if (process.env.SUI_RPC_URL) urls.push(process.env.SUI_RPC_URL);
      urls.push("https://fullnode.mainnet.sui.io:443");
      return [...new Set(urls.filter(Boolean))];
    }
  },
  ton: {
    aliases: new Set(["ton", "-239"]),
    allowedMethods: new Set(["getAddressInformation"]),
    getRpcUrls() {
      const urls = [];
      if (process.env.TON_RPC) urls.push(process.env.TON_RPC);
      if (process.env.TON_RPC_URL) urls.push(process.env.TON_RPC_URL);
      return [...new Set(urls.filter(Boolean))];
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

export function getNonEvmRpcUrls(chainOrId) {
  const chain = resolveNonEvmChain(chainOrId);
  if (!chain) return [];
  return NON_EVM_RPC_CONFIG[chain].getRpcUrls();
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

  const rpcUrls = getNonEvmRpcUrls(chain);
  if (!rpcUrls.length) {
    throw new Error(`No RPC URL configured for non-EVM chain: ${chain}`);
  }

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: methodName,
    params: Array.isArray(params) ? params : []
  });

  let lastError = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal,
        body: requestBody
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(text || `Invalid JSON response from ${rpcUrl}`);
      }

      if (!res.ok) {
        const rpcError = parsed?.error?.message || `HTTP ${res.status}`;
        throw new Error(rpcError);
      }

      return parsed;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to call ${chain} RPC method: ${methodName}`);
}
