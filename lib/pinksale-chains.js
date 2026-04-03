export const PINKSALE_CHAIN_CONFIG = {
  1: {
    chainId: 1,
    name: "Ethereum",
    slug: "ethereum",
    aliases: ["eth"],
    family: "evm",
    defaultRpcUrl: "https://ethereum.publicnode.com",
    rpcEnvVar: "ETHEREUM_RPC_URL"
  },
  25: {
    chainId: 25,
    name: "Cronos",
    slug: "cronos",
    aliases: ["cro"],
    family: "evm",
    defaultRpcUrl: "https://evm.cronos.org",
    rpcEnvVar: "CRONOS_RPC_URL"
  },
  56: {
    chainId: 56,
    name: "BNB Chain",
    slug: "bsc",
    aliases: ["bnb", "binance-smart-chain"],
    family: "evm",
    defaultRpcUrl: "https://bsc-dataseed.binance.org/",
    rpcEnvVar: "BSC_RPC_URL"
  },
  97: {
    chainId: 97,
    name: "BNB Chain Testnet",
    slug: "bsc",
    aliases: ["bsc-test", "bnb-testnet"],
    family: "evm",
    defaultRpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545/",
    rpcEnvVar: "BSC_TESTNET_RPC_URL"
  },
  109: {
    chainId: 109,
    name: "Shibarium",
    slug: "shibarium",
    family: "evm",
    defaultRpcUrl: "https://rpc.shibrpc.com",
    rpcEnvVar: "SHIBARIUM_RPC_URL"
  },
  130: {
    chainId: 130,
    name: "Unichain",
    slug: "unichain",
    family: "evm",
    defaultRpcUrl: "https://mainnet.unichain.org",
    rpcEnvVar: "UNICHAIN_RPC_URL"
  },
  137: {
    chainId: 137,
    name: "Polygon",
    slug: "polygon",
    aliases: ["matic"],
    family: "evm",
    defaultRpcUrl: "https://polygon-bor.publicnode.com",
    rpcEnvVar: "POLYGON_RPC_URL"
  },
  196: {
    chainId: 196,
    name: "X Layer",
    slug: "xlayer",
    aliases: ["x-layer"],
    family: "evm",
    defaultRpcUrl: "https://rpc.xlayer.tech",
    rpcEnvVar: "XLAYER_RPC_URL"
  },
  250: {
    chainId: 250,
    name: "Fantom",
    slug: "fantom",
    aliases: ["ftm"],
    family: "evm",
    defaultRpcUrl: "https://rpc.ftm.tools",
    rpcEnvVar: "FANTOM_RPC_URL"
  },
  369: {
    chainId: 369,
    name: "PulseChain",
    slug: "pulsechain",
    aliases: ["pulse"],
    family: "evm",
    defaultRpcUrl: "https://rpc.pulsechain.com",
    rpcEnvVar: "PULSECHAIN_RPC_URL"
  },
  1116: {
    chainId: 1116,
    name: "Core",
    slug: "core",
    family: "evm",
    defaultRpcUrl: "https://rpc.coredao.org",
    rpcEnvVar: "CORE_RPC_URL"
  },
  2000: {
    chainId: 2000,
    name: "Dogechain",
    slug: "dogechain",
    family: "evm",
    defaultRpcUrl: "https://rpc.dogechain.dog",
    rpcEnvVar: "DOGECHAIN_RPC_URL"
  },
  3797: {
    chainId: 3797,
    name: "Alvey",
    slug: "alvey",
    family: "evm",
    defaultRpcUrl: "https://rpc.alvey.io",
    rpcEnvVar: "ALVEY_RPC_URL"
  },
  7000: {
    chainId: 7000,
    name: "ZetaChain",
    slug: "zetachain",
    family: "evm",
    defaultRpcUrl: "https://zetachain-evm.blockpi.network/v1/rpc/public",
    rpcEnvVar: "ZETACHAIN_RPC_URL"
  },
  7171: {
    chainId: 7171,
    name: "Bitrock",
    slug: "bitrock",
    family: "evm",
    defaultRpcUrl: "https://connect.bit-rock.io",
    rpcEnvVar: "BITROCK_RPC_URL"
  },
  8453: {
    chainId: 8453,
    name: "Base",
    slug: "base",
    family: "evm",
    defaultRpcUrl: "https://base.publicnode.com",
    rpcEnvVar: "BASE_RPC_URL"
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum",
    slug: "arbitrum",
    family: "evm",
    defaultRpcUrl: "https://arbitrum-one.publicnode.com",
    rpcEnvVar: "ARBITRUM_RPC_URL"
  },
  43114: {
    chainId: 43114,
    name: "Avalanche",
    slug: "avax",
    aliases: ["avalanche"],
    family: "evm",
    defaultRpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    rpcEnvVar: "AVALANCHE_RPC_URL"
  },
  50104: {
    chainId: 50104,
    name: "Sui",
    slug: "sui",
    aliases: ["sui-mainnet"],
    family: "non-evm"
  },
  501424: {
    chainId: 501424,
    name: "Solana",
    slug: "solana",
    aliases: ["sol"],
    family: "non-evm"
  },
  "-239": {
    chainId: -239,
    name: "TON",
    slug: "ton",
    aliases: ["the-open-network"],
    family: "non-evm"
  }
};

function normalizeChainId(chainOrId) {
  if (typeof chainOrId === "number" && Number.isFinite(chainOrId)) return chainOrId;
  if (typeof chainOrId === "string") {
    const trimmed = chainOrId.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

export function getChainConfig(chainOrId) {
  const numericId = normalizeChainId(chainOrId);
  if (numericId != null) {
    return PINKSALE_CHAIN_CONFIG[numericId] || null;
  }

  if (typeof chainOrId !== "string") return null;
  const slug = chainOrId.trim().toLowerCase();
  if (!slug) return null;

  return (
    Object.values(PINKSALE_CHAIN_CONFIG).find(
      (config) =>
        String(config?.slug || "").toLowerCase() === slug ||
        (Array.isArray(config?.aliases) &&
          config.aliases.some((alias) => String(alias || "").toLowerCase() === slug))
    ) || null
  );
}

export function getChainName(chainOrId) {
  const config = getChainConfig(chainOrId);
  if (config) return config.name;

  const numericId = normalizeChainId(chainOrId);
  return numericId != null ? `Chain ${numericId}` : String(chainOrId ?? "-");
}

export function getChainSlug(chainOrId) {
  return getChainConfig(chainOrId)?.slug || null;
}

export function getDefaultEvmRpcUrl(chainOrId) {
  const config = getChainConfig(chainOrId);
  return config?.family === "evm" ? config.defaultRpcUrl || "" : "";
}

export function isEvmChain(chainOrId) {
  return getChainConfig(chainOrId)?.family === "evm";
}

export function isNonEvmChain(chainOrId) {
  return getChainConfig(chainOrId)?.family === "non-evm";
}

export function getPinksaleLaunchpadUrl(chainOrId, poolAddress) {
  const encodedPoolAddress = encodeURIComponent(poolAddress || "");
  const config = getChainConfig(chainOrId);

  if (!config || !encodedPoolAddress) {
    return `https://www.pinksale.finance/launchpad/${encodedPoolAddress}`;
  }

  if (config.family === "non-evm") {
    return `https://www.pinksale.finance/${config.slug}/launchpad/${encodedPoolAddress}`;
  }

  return `https://www.pinksale.finance/launchpad/${config.slug}/${encodedPoolAddress}`;
}
