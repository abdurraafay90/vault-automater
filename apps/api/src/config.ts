import { z } from 'zod';

if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  EVM_TESTNET_RPC_URL: z.string().trim().default('https://eth-sepolia.g.alchemy.com/v2/-JP0qskklLhdu7bSUgI_K'),
  EVM_TESTNET_CHAIN_ID: z.coerce.number().int().default(11155111),
  EVM_TESTNET_EXPLORER_URL: z.string().trim().default('https://sepolia.etherscan.io'),
  EVM_MAINNET_RPC_URL: z.string().trim().default('https://eth-mainnet.g.alchemy.com/v2/-JP0qskklLhdu7bSUgI_K'),
  EVM_MAINNET_CHAIN_ID: z.coerce.number().int().default(1),
  EVM_MAINNET_EXPLORER_URL: z.string().trim().default('https://etherscan.io'),
  EVM_RPC_URL: z.url().default('https://eth-sepolia.g.alchemy.com/v2/-JP0qskklLhdu7bSUgI_K'),
  EVM_CHAIN_ID: z.coerce.number().int().default(11155111),
  EVM_EXPLORER_URL: z.url().default('https://sepolia.etherscan.io'),
  BNB_MAINNET_RPC_URL: z.string().trim().default('https://bsc-dataseed.binance.org/'),
  BNB_MAINNET_CHAIN_ID: z.coerce.number().int().default(56),
  BNB_MAINNET_EXPLORER_URL: z.string().trim().default('https://bscscan.com'),
  BNB_TESTNET_RPC_URL: z.string().trim().default('https://data-seed-prebsc-1-s1.binance.org:8545/'),
  BNB_TESTNET_CHAIN_ID: z.coerce.number().int().default(97),
  BNB_TESTNET_EXPLORER_URL: z.string().trim().default('https://testnet.bscscan.com'),
  VAULT_1_NAME: z.string().min(1).default('Stablecoin Yield'),
  VAULT_1_ADDRESS: z.string().trim().optional().default(''),
  VAULT_1_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_2_NAME: z.string().min(1).default('Opportunistic Credit'),
  VAULT_2_ADDRESS: z.string().trim().optional().default(''),
  VAULT_2_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_3_NAME: z.string().min(1).default('Core Income'),
  VAULT_3_ADDRESS: z.string().trim().optional().default(''),
  VAULT_3_IBC_RECEIVER: z.string().trim().optional().default(''),
  VAULT_4_NAME: z.string().min(1).default('Nawa Finance'),
  VAULT_4_ADDRESS: z.string().trim().default('0x6FE78B942C566fE2b8D0881cf3577C1B1511F204'),
  VAULT_4_CHAIN_TYPE: z.enum(['zigchain', 'erc']).default('erc'),
  VAULT_5_NAME: z.string().min(1).default('Valdora'),
  VAULT_5_ADDRESS: z.string().trim().default('0x1754fCD1F0EBb306286dd16F00abCf46731a92FC'),
  VAULT_5_CHAIN_TYPE: z.enum(['zigchain', 'erc']).default('erc'),
  VAULT_6_NAME: z.string().min(1).default('Sepolia Testnet Vault'),
  VAULT_6_ADDRESS: z.string().trim().default('0xe1908800dBEFE8a571A8580D9Cc546091e6FDF9a'),
  VAULT_6_CHAIN_TYPE: z.enum(['zigchain', 'erc']).default('erc'),
  BACKEND_SIGNER_ENABLED: z.stringbool().default(false),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28_800),
});

export const config = environmentSchema.parse(process.env);
export const vaultsConfigured = Boolean(
  (config.VAULT_1_IBC_RECEIVER || config.VAULT_1_ADDRESS)
  && (config.VAULT_2_IBC_RECEIVER || config.VAULT_2_ADDRESS)
  && (config.VAULT_3_IBC_RECEIVER || config.VAULT_3_ADDRESS),
);
