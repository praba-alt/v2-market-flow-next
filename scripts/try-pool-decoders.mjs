import { AbiCoder, FunctionFragment, Interface, JsonRpcProvider } from 'ethers';

import { getChainName, getEvmRpcCandidates } from '../lib/pinksale-chains.js';

const abiCoder = AbiCoder.defaultAbiCoder();

const chainId = Number(process.argv[2] || 8453);
const poolAddress = String(process.argv[3] || '').trim();

if (!Number.isFinite(chainId) || !poolAddress) {
  console.error('Usage: node scripts/try-pool-decoders.mjs <chainId> <poolAddress>');
  process.exit(1);
}

const SETTINGS_CANDIDATES = {
  legacy_v12_view:
    '(address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint256 liquidityListingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
  v2_subscription_view:
    '(address token, address currency, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 listingRate, uint256 softCapTokens, uint256 totalSellingTokens, uint256 hardCapTokensPerUser, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
  fairlaunch_pool_type_view:
    '(address token, address currency, uint256 startTime, uint256 endTime, uint256 softCap, uint256 hardCap, uint256 totalSellingTokens, uint256 rate, uint256 listingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint8 poolType)',
  manual_list_presale_view:
    '(address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint128 liquidityPercent, uint128 refundType)',
  presale_full_create:
    '(address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256[2] contributionSetting, uint256 softCap, uint256 hardCap, uint256 liquidityListingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint128[2] feePercent)',
  subscription_full_create:
    '(address token, address currency, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 listingRate, uint256 softCapTokens, uint256 totalSellingTokens, uint256 hardCapTokensPerUser, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint128[2] feePercent)',
  overflow_full_create:
    '(address token, address currency, uint256 startTime, uint256 endTime, uint256[2] contributionSetting, uint256 softCap, uint256 hardCap, uint256 totalSellingTokens, uint256 rate, uint256 listingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint128[2] feePercent, uint8 poolType)',
  fairlaunch_full_create:
    '(address token, address currency, address[3] dependencies, uint256 startTime, uint256 endTime, uint256 softCap, uint256 totalSellingTokens, uint256 maxContribution, uint256 liquidityLockDays, uint128[2] liquidityAndBuyback, uint128[2] feePercent)',
  manual_list_fairlaunch_full_create:
    '(address token, address currency, address[2] dependencies, uint256 startTime, uint256 endTime, uint256 softCap, uint256 totalSellingTokens, uint256 maxContribution, uint128 liquidityPercent, uint128[2] feePercent)'
};

const STATES_CANDIDATES = {
  legacy_v12_view:
    '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, uint256 totalVestedTokens, int256 lockId, string poolDetails, string kycDetails)',
  v2_subscription_view:
    '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)',
  fairlaunch_pool_type_view:
    '(uint8 state, uint8 calculationState, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails, bytes32 allocationRoot, bytes32 noAllocationRoot)',
  manual_list_presale_view:
    '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, string poolDetails, string kycDetails)',
  committed_plus_vested:
    '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, uint256 totalVestedTokens, int256 lockId, string poolDetails, string kycDetails)'
};

function normalizeDecoded(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDecoded(item));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!Number.isNaN(Number(key))) continue;
      out[key] = normalizeDecoded(item);
    }
    return out;
  }
  return String(value);
}

async function rawCall(provider, methodName) {
  const iface = new Interface([`function ${methodName}()`]);
  const data = iface.encodeFunctionData(methodName);
  return provider.call({
    to: poolAddress,
    data
  });
}

function tryCandidates(rawHex, candidates) {
  const matches = [];
  for (const [name, typeSignature] of Object.entries(candidates)) {
    try {
      const decoded = abiCoder.decode([typeSignature], rawHex);
      matches.push({
        name,
        decoded: normalizeDecoded(decoded[0])
      });
    } catch {
      // ignore failed candidate
    }
  }
  return matches;
}

async function main() {
  const rpcUrl = getEvmRpcCandidates(chainId)[0];
  const provider = new JsonRpcProvider(rpcUrl, Number(chainId), {
    staticNetwork: true,
    batchMaxCount: 1
  });

  console.log(`Chain: ${getChainName(chainId)} (${chainId})`);
  console.log(`Pool:  ${poolAddress}`);
  console.log(`RPC:   ${rpcUrl}`);

  for (const methodName of ['poolSettings', 'poolStates']) {
    try {
      const rawHex = await rawCall(provider, methodName);
      console.log(`\n${methodName} raw bytes: ${(rawHex.length - 2) / 2}`);
      const words = [];
      for (let i = 2; i < rawHex.length; i += 64) {
        words.push(rawHex.slice(i, i + 64));
      }
      console.log('first words:');
      for (const [index, word] of words.slice(0, 16).entries()) {
        console.log(`  [${index}] ${word}`);
      }
      const matches = tryCandidates(
        rawHex,
        methodName === 'poolSettings' ? SETTINGS_CANDIDATES : STATES_CANDIDATES
      );
      if (!matches.length) {
        console.log('No decoder candidates matched.');
        continue;
      }
      for (const match of matches) {
        console.log(`- ${match.name}`);
        console.log(JSON.stringify(match.decoded, null, 2));
      }
    } catch (error) {
      console.log(`\n${methodName} failed: ${String(error?.message || error)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
