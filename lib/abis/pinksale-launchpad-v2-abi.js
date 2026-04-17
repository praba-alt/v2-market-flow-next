// PinkSale pool and helper views derived from PinkSale frontend bundles in this workspace.

export const PINKSALE_ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)'
];

export const PINKSALE_POOL_HELPER_ABI = [
  'function calculationStage() view returns (uint8 stage, uint256 currentIndex, uint256 finishedAllocatingUserCount, uint256 distributableRaised, uint256 excessiveAllocations, uint256 tempDistributableRaised, uint256 tempExcessiveAllocations)',
  'function getContributionSettings() view returns (uint256 min, uint256 max)',
  'function contributorVestingSettings() view returns (uint256 tgeReleasePct, uint256 cycleReleasePct, uint256 cycle)',
  'function getContributorCount() view returns (uint256)',
  'function getFeeSettings() view returns (uint128 currency, uint128 token)',
  'function getOwner() view returns (address)',
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'function router() view returns (address)',
  'function version() view returns (uint8)',
  'function getImplementationVersion() view returns (uint8)',
  'function needCalculate() view returns (bool)',
  'function initialMarketCap() view returns (uint256)',
  'function poolType() view returns (uint8)',
  'function softCap() view returns (uint256)',
  'function hardCap() view returns (uint256)',
  'function min() view returns (uint256)',
  'function max() view returns (uint256)',
  'function publicSaleStartTime() view returns (uint256)',
  'function claimTime() view returns (uint256)',
  'function poolDetails() view returns (string)',
  'function kycDetails() view returns (string)',
  'function totalSellingTokens() view returns (uint256)'
];

export const PINKSALE_LAUNCHPAD_LEGACY_SCALAR_ABI = [
  'function token() view returns (address)',
  'function currency() view returns (address)',
  'function startTime() view returns (uint256)',
  'function endTime() view returns (uint256)',
  'function publicSaleStartTime() view returns (uint256)',
  'function claimTime() view returns (uint256)',
  'function rate() view returns (uint256)',
  'function listingRate() view returns (uint256)',
  'function state() view returns (uint8)',
  'function finishTime() view returns (uint256)',
  'function totalRaised() view returns (uint256)',
  'function totalCommitted() view returns (uint256)',
  'function totalVolumePurchased() view returns (uint256)',
  'function totalSellingTokens() view returns (uint256)',
  'function liquidityUnlockTime() view returns (uint256)',
  'function liquidityPercentage() view returns (uint256)',
  'function liquidityPercent() view returns (uint256)',
  'function buybackPercentage() view returns (uint256)',
  'function initialMarketCap() view returns (uint256)',
  'function getContributorCount() view returns (uint256)',
  'function poolDetails() view returns (string)',
  'function kycDetails() view returns (string)'
];

export const PINKSALE_POOL_PROFILES = {
  legacy_presale_v12: {
    settingsSignature:
      '(address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint256 liquidityListingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
    statesSignature:
      '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, uint256 totalVestedTokens, int256 lockId, string poolDetails, string kycDetails)'
  },
  subscription_v2: {
    settingsSignature:
      '(address token, address currency, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 listingRate, uint256 softCapTokens, uint256 totalSellingTokens, uint256 hardCapTokensPerUser, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType)',
    statesSignature:
      '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails)'
  },
  manual_list_presale: {
    settingsSignature:
      '(address token, address currency, address affliateProgram, address whitelistManager, uint256 startTime, uint256 endTime, uint256 rate, uint256 softCap, uint256 hardCap, uint128 liquidityPercent, uint128 refundType)',
    statesSignature:
      '(uint8 state, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 totalVolumePurchased, string poolDetails, string kycDetails)'
  },
  overflow_pool_type: {
    settingsSignature:
      '(address token, address currency, uint256 startTime, uint256 endTime, uint256 softCap, uint256 hardCap, uint256 totalSellingTokens, uint256 rate, uint256 listingRate, uint256 liquidityLockDays, uint128 liquidityPercent, uint128 refundType, uint8 poolType)',
    statesSignature:
      '(uint8 state, uint8 calculationState, uint256 finishTime, uint256 totalRaised, uint256 totalCommitted, uint256 liquidityUnlockTime, int256 lockId, string poolDetails, string kycDetails, bytes32 allocationRoot, bytes32 noAllocationRoot)'
  }
};

// Keep compatibility for older scripts importing these names.
export const PINKSALE_LAUNCHPAD_V2_CORE_ABI = [];
export const PINKSALE_LAUNCHPAD_V2_OPTIONAL_ABI = [];
export const PINKSALE_LAUNCHPAD_V2_ABI = [];

// Chain hints derived from live samples and PinkSale bundle signatures.
export const CHAIN_POOL_ABI_RECOMMENDATION = {
  1: 'legacy_presale_v12',
  25: 'legacy_presale_v12',
  56: 'legacy_presale_v12',
  130: 'subscription_v2',
  137: 'legacy_presale_v12',
  196: 'subscription_v2',
  369: 'subscription_v2',
  1116: 'subscription_v2',
  2000: 'subscription_v2',
  3797: 'subscription_v2',
  7000: 'subscription_v2',
  8453: 'manual_list_presale',
  42161: 'subscription_v2',
  43114: 'legacy_presale_v12'
};
