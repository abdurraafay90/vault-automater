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
  RPC_URL: z.url().default('https://testnet-rpc.zigchain.com'),
  API_URL: z.url().default('https://testnet-api.zigchain.com'),
  BLOCK_EXPLORER_URL: z.url().default('https://testnet.zigscan.org'),
  NATIVE_TOKEN_SYMBOL: z.string().min(1).default('ZIG'),
  NATIVE_TOKEN_DENOM: z.string().min(1).default('uzig'),
  NATIVE_TOKEN_DECIMALS: z.coerce.number().int().nonnegative().max(255).default(6),
  VAULT_1_NAME: z.string().min(1).default('Stablecoin Yield'),
  VAULT_1_ADDRESS: z.string().optional().default(''),
  VAULT_2_NAME: z.string().min(1).default('Opportunistic Credit'),
  VAULT_2_ADDRESS: z.string().optional().default(''),
  VAULT_3_NAME: z.string().min(1).default('Core Income'),
  VAULT_3_ADDRESS: z.string().optional().default(''),
  BACKEND_SIGNER_ENABLED: z.stringbool().default(false),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28_800),
});

export const config = environmentSchema.parse(process.env);
export const vaultsConfigured = Boolean(config.VAULT_1_ADDRESS && config.VAULT_2_ADDRESS && config.VAULT_3_ADDRESS);
