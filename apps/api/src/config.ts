import { z } from 'zod';

if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Keyless public mainnet RPCs. Index 0 is primary, the rest are ordered fallbacks.
const DEFAULT_ETH_RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.mevblocker.io',
  'https://eth.blockrazor.xyz',
  'https://eth-pokt.nodies.app',
  'https://gateway.tenderly.co/public/mainnet',
];

const DEFAULT_BSC_RPC_URLS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.rpc.blxrbdn.com',
];

const optionalEvmAddress = z.string().trim().regex(/^(0x[0-9a-fA-F]{40})?$/, 'Must be a 0x-prefixed 40-hex-character address, or empty.').default('');

function splitUrls(value: string, fallback: string[]): string[] {
  const list = value.split(',').map((url) => url.trim()).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

const environmentSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_ORIGIN: z.url().default('http://localhost:4560'),
  CHAIN_TYPE: z.enum(['evm', 'cosmos-sdk', 'cosmwasm', 'other']).optional(),
  CHAIN_NAME: z.string().min(1).default('ZIGChain Testnet'),
  CHAIN_ID: z.string().min(1).default('zig-test-2'),
  RPC_URL: z.url().default('https://zigchain-mainnet-lcd.zigscan.net'),
  API_URL: z.url().default('https://zigchain-mainnet-lcd.zigscan.net'),
  BLOCK_EXPLORER_URL: z.url().default('https://zigscan.org'),
  NATIVE_TOKEN_SYMBOL: z.string().min(1).default('ZIG'),
  NATIVE_TOKEN_DENOM: z.string().min(1).default('uzig'),
  NATIVE_TOKEN_DECIMALS: z.coerce.number().int().nonnegative().max(255).default(6),
  TOKEN_SYMBOL: z.string().min(1).default('ZIG'),
  TOKEN_DENOM: z.string().min(1).default('uzig'),
  TOKEN_DECIMALS: z.coerce.number().int().nonnegative().max(255).default(6),
  IBC_SOURCE_PORT: z.string().trim().min(1).default('transfer'),
  IBC_SOURCE_CHANNEL: z.string().trim().min(1).default('channel-3'),
  IBC_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  ORBITER_CCTP_ENABLED: z.stringbool().default(false),
  ORBITER_FEE_RECIPIENT: z.string().trim().optional().default(''),
  ORBITER_FEE_AMOUNT: z.string().trim().optional().default(''),
  ORBITER_CCTP_DESTINATION_DOMAIN: z.coerce.number().int().nonnegative().default(0),
  ORBITER_CCTP_MINT_RECIPIENT: z.string().trim().optional().default(''),
  ORBITER_CCTP_DESTINATION_CALLER: z.string().trim().optional().default(''),
  ORBITER_PASSTHROUGH_PAYLOAD: z.string().optional().default(''),
  EVM_MAINNET_CHAIN_ID: z.coerce.number().int().default(1),
  EVM_MAINNET_EXPLORER_URL: z.string().trim().default('https://etherscan.io'),
  BNB_MAINNET_CHAIN_ID: z.coerce.number().int().default(56),
  BNB_MAINNET_EXPLORER_URL: z.string().trim().default('https://bscscan.com'),
  ETH_RPC_URLS: z.string().trim().default(DEFAULT_ETH_RPC_URLS.join(',')),
  ETH_WS_URLS: z.string().trim().default('wss://ethereum-rpc.publicnode.com'),
  BSC_RPC_URLS: z.string().trim().default(DEFAULT_BSC_RPC_URLS.join(',')),
  BSC_WS_URLS: z.string().trim().default('wss://bsc-rpc.publicnode.com'),
  VAULT_1_NAME: z.string().min(1).default('Stablecoin Yield'),
  VAULT_1_ADDRESS: z.string().trim().optional().default(''),
  VAULT_1_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_2_NAME: z.string().min(1).default('Opportunistic Credit'),
  VAULT_2_ADDRESS: z.string().trim().optional().default(''),
  VAULT_2_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_3_NAME: z.string().min(1).default('Core Income'),
  VAULT_3_ADDRESS: z.string().trim().optional().default(''),
  VAULT_3_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_4_NAME: z.string().min(1).default('Valdora'),
  VAULT_4_ADDRESS: z.string().trim().default('0x1754fCD1F0EBb306286dd16F00abCf46731a92FC'),
  VAULT_4_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('erc'),
  VAULT_5_NAME: z.string().min(1).default('NAWA'),
  VAULT_5_ADDRESS: z.string().trim().default('0x3c7C22d108ddbD8190f3CAa3A5BCd99cBD8469e2'),
  VAULT_5_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('erc'),
  VAULT_6_NAME: z.string().min(1).default('TokenX main wallet'),
  VAULT_6_ADDRESS: z.string().trim().default('0xe6C1ae22207DCe5C5fE66BEC7A314aa0B55C3e51'),
  VAULT_6_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('erc'),
  VAULT_7_NAME: z.string().min(1).default('TokenX admin wallet'),
  VAULT_7_ADDRESS: z.string().trim().default('0x1dA18CeEDf24dEb656FB85ee40f49c3f698b13c0'),
  VAULT_7_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('erc'),
  VAULT_8_NAME: z.string().min(1).default('TokenX main wallet'),
  VAULT_8_ADDRESS: z.string().trim().default('0xe6C1ae22207DCe5C5fE66BEC7A314aa0B55C3e51'),
  VAULT_8_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('bnb'),
  VAULT_9_NAME: z.string().min(1).default('TokenX admin wallet'),
  VAULT_9_ADDRESS: z.string().trim().default('0x1dA18CeEDf24dEb656FB85ee40f49c3f698b13c0'),
  VAULT_9_CHAIN_TYPE: z.enum(['zigchain', 'erc', 'bnb']).default('bnb'),
  // TokenX vault contracts exposing vaultStats() — same address on both
  // Ethereum and BSC (deterministic deployment). TVL = activeAUM +
  // pendingLiabilities, read directly from the contract. Empty = not shown.
  TOKENX_USDC_VAULT_ADDRESS: optionalEvmAddress,
  TOKENX_USDT_VAULT_ADDRESS: optionalEvmAddress,
  VAULT_STATS_REFRESH_MINUTES: z.coerce.number().positive().max(24 * 60).default(30),
  // Set when the API sits behind a reverse proxy or the web console's /api
  // proxy (e.g. "true", or a hop count / CIDR list). Makes rate limits apply
  // per real client instead of to everyone behind the proxy as one IP.
  TRUST_PROXY: z.string().trim().optional().default(''),
  BACKEND_SIGNER_ENABLED: z.stringbool().default(false),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28_800),
});

const parsedEnv = environmentSchema.parse(process.env);

const ethRpcUrls = splitUrls(parsedEnv.ETH_RPC_URLS, DEFAULT_ETH_RPC_URLS);
const bscRpcUrls = splitUrls(parsedEnv.BSC_RPC_URLS, DEFAULT_BSC_RPC_URLS);

export const config = {
  ...parsedEnv,
  ethRpcUrls,
  bscRpcUrls,
  ethWsUrls: parsedEnv.ETH_WS_URLS.split(',').map((url) => url.trim()).filter(Boolean),
  bscWsUrls: parsedEnv.BSC_WS_URLS.split(',').map((url) => url.trim()).filter(Boolean),
  // Primary endpoint; clients fall back through the full list in order.
  ETH_MAINNET_RPC_URL: ethRpcUrls[0]!,
  BNB_MAINNET_RPC_URL: bscRpcUrls[0]!,
};

export const vaultsConfigured = Boolean(
  (config.VAULT_1_IBC_RECEIVER || config.VAULT_1_ADDRESS)
  && (config.VAULT_2_IBC_RECEIVER || config.VAULT_2_ADDRESS)
  && (config.VAULT_3_IBC_RECEIVER || config.VAULT_3_ADDRESS),
);
