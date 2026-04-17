import fs from 'fs';
import path from 'path';

const ROOT = '/Users/macbook/Fortuna Project';

const CANDIDATE_FILES = [
  '/Users/macbook/Fortuna Project/contract-experiments/v2-market-flow-next/lib/abis/pinksale-launchpad-v2-abi.js',
  '/Users/macbook/Fortuna Project/contract-experiments/v2-market-flow-next/pages/api/pinksale-tokenomics.js',
  '/Users/macbook/Fortuna Project/fortuna-app/src/constants/rpc.ts',
  '/Users/macbook/Fortuna Project/fortuna_data_importer/src/config/constants.js',
  '/Users/macbook/Fortuna Project/contract-experiments/pinksale_chunks_all/2354-2a75227e3ae13242.js',
  '/Users/macbook/Fortuna Project/contract-experiments/Launchpad List _ Pinksale_files/2354-2a75227e3ae13242.js',
  '/Users/macbook/Fortuna Project/contract-experiments/Launchpad List _ Pinksale_V2_files/2354-2a75227e3ae13242.js'
];

const SELECTOR_PATTERNS = [
  /const\s+GET_LOCK_BY_ID_SELECTOR\s*=\s*"([^"]+)"/g,
  /const\s+ERC20_DECIMALS_SELECTOR\s*=\s*"([^"]+)"/g,
  /const\s+ERC20_TOTAL_SUPPLY_SELECTOR\s*=\s*"([^"]+)"/g
];

function rel(filePath) {
  if (filePath.startsWith(ROOT)) {
    return filePath.slice(ROOT.length + 1);
  }
  return filePath;
}

function extractFunctionSignatures(text) {
  const out = [];
  const regex = /"function\s+[^"]+"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push(match[0].slice(1, -1));
  }
  return out;
}

function extractSelectors(text) {
  const out = [];
  for (const pattern of SELECTOR_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      out.push(match[1]);
    }
  }
  return out;
}

function toSortedObjSetMap(map) {
  const obj = {};
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    obj[key] = [...map.get(key)].sort((a, b) => a.localeCompare(b));
  }
  return obj;
}

const bySignature = new Map();
const bySelector = new Map();
const scannedFiles = [];

for (const file of CANDIDATE_FILES) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  scannedFiles.push(rel(file));

  for (const sig of extractFunctionSignatures(text)) {
    if (!bySignature.has(sig)) bySignature.set(sig, new Set());
    bySignature.get(sig).add(rel(file));
  }

  for (const selector of extractSelectors(text)) {
    if (!bySelector.has(selector)) bySelector.set(selector, new Set());
    bySelector.get(selector).add(rel(file));
  }
}

const signatures = [...bySignature.keys()].sort((a, b) => a.localeCompare(b));
const selectors = [...bySelector.keys()].sort((a, b) => a.localeCompare(b));

const payload = {
  generated_at: new Date().toISOString(),
  purpose: 'Relevant ABI catalog across Fortuna workspace for PinkSale/V2 market flow chains',
  scanned_files: scannedFiles.sort((a, b) => a.localeCompare(b)),
  total_unique_function_signatures: signatures.length,
  total_unique_selectors: selectors.length,
  selectors,
  signatures,
  sources_by_signature: toSortedObjSetMap(bySignature),
  sources_by_selector: toSortedObjSetMap(bySelector)
};

const outPath = path.join(
  '/Users/macbook/Fortuna Project/contract-experiments/v2-market-flow-next/data',
  'relevant-abis-workspace.json'
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

console.log(`Wrote ABI catalog: ${outPath}`);
console.log(`Unique function signatures: ${signatures.length}`);
console.log(`Unique selectors: ${selectors.length}`);
