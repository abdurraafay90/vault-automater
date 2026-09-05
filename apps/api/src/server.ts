import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, createCustomVault, createSession, createUser, deleteCustomVault, ensureAdmin, listCustomVaults, listUsers, revokeSession, type AuthUser, userForSession } from './auth-store.js';
import { config, vaultsConfigured } from './config.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie', '*.privateKey', '*.mnemonic', '*.secret'] } });

await app.register(helmet);
await app.register(cookie);
await app.register(cors, {
  origin: (origin, cb) => {
    cb(null, true);
  },
  credentials: true,
});
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });


const SESSION_COOKIE = 'vaultflow_session';
const requestUsers = new WeakMap<object, AuthUser>();
ensureAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);

function currentUser(request: FastifyRequest) { return requestUsers.get(request); }

app.addHook('preHandler', async (request, reply) => {
  const path = request.url.split('?')[0] ?? request.url;
  if (!path.startsWith('/api/') || path === '/api/auth/login' || path === '/api/config/public' || path.startsWith('/api/vaults/custom')) return;

  const token = request.cookies[SESSION_COOKIE];
  const user = token ? userForSession(token) : null;
  if (!user) return reply.code(401).send({ code: 'AUTHENTICATION_REQUIRED' });
  requestUsers.set(request, user);
});

app.get('/', async (_request, reply) => reply.redirect(config.APP_ORIGIN));
app.get('/health', async () => ({ status: 'ok', service: 'api' }));

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
  const input = z.object({ email: z.email(), password: z.string().min(1).max(256) }).safeParse(request.body);
  if (!input.success) return reply.code(400).send({ code: 'INVALID_LOGIN_REQUEST' });
  const user = authenticate(input.data.email, input.data.password);
  if (!user) return reply.code(401).send({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  const session = createSession(user.id, config.SESSION_TTL_SECONDS);
  const isSecure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production' && !config.APP_ORIGIN.startsWith('http://localhost'));
  const sameSite = (process.env.COOKIE_SAMESITE as 'strict' | 'lax' | 'none') || 'lax';
  reply.setCookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite,
    secure: isSecure,
    path: '/',
    maxAge: config.SESSION_TTL_SECONDS,
  });
  return { user };
});

app.get('/api/auth/me', async (request) => ({ user: currentUser(request) }));

app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies[SESSION_COOKIE];
  if (token) revokeSession(token);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/admin/users', async (request, reply) => {
  if (currentUser(request)?.role !== 'ADMIN') return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
  return { users: listUsers() };
});

app.post('/api/admin/users', async (request, reply) => {
  if (currentUser(request)?.role !== 'ADMIN') return reply.code(403).send({ code: 'ADMIN_REQUIRED' });
  const input = z.object({ email: z.email(), password: z.string().min(8).max(128) }).safeParse(request.body);
  if (!input.success) return reply.code(400).send({ code: 'INVALID_USER', message: 'Use a valid email and a password of at least 8 characters.' });
  try {
    return reply.code(201).send({ user: createUser(input.data.email, input.data.password) });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return reply.code(409).send({ code: 'EMAIL_ALREADY_EXISTS' });
    throw error;
  }
});

app.get('/api/vaults/custom', async () => ({ vaults: listCustomVaults() }));

app.post('/api/vaults/custom', async (request, reply) => {
  const input = z.object({
    name: z.string().min(1).max(64),
    address: z.string().min(1).max(128),
    chainType: z.enum(['zigchain', 'erc']),
    tokenSymbol: z.string().min(1).max(16).optional(),
    tokenDecimals: z.coerce.number().int().min(0).max(255).optional(),
    summary: z.string().max(256).optional(),
  }).safeParse(request.body);
  if (!input.success) return reply.code(400).send({ code: 'INVALID_VAULT_PAYLOAD' });
  const vault = createCustomVault(input.data);
  return reply.code(201).send({ vault });
});

app.delete('/api/vaults/custom/:id', async (request, reply) => {
  const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ code: 'INVALID_VAULT_ID' });
  const deleted = deleteCustomVault(params.data.id);
  return reply.code(200).send({ success: true, deleted });
});


app.get('/api/config/public', async () => ({
  chain: { type: config.CHAIN_TYPE ?? 'cosmos-sdk', name: config.CHAIN_NAME, id: config.CHAIN_ID, rpcUrl: config.RPC_URL, apiUrl: config.API_URL, explorerUrl: config.BLOCK_EXPLORER_URL },
  evm: {
    rpcUrl: config.EVM_RPC_URL,
    chainId: config.EVM_CHAIN_ID,
    explorerUrl: config.EVM_EXPLORER_URL,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  nativeToken: { symbol: config.NATIVE_TOKEN_SYMBOL, denom: config.NATIVE_TOKEN_DENOM, decimals: config.NATIVE_TOKEN_DECIMALS },
  token: { symbol: config.TOKEN_SYMBOL, denom: config.TOKEN_DENOM, decimals: config.TOKEN_DECIMALS },
  ibcTransfer: {
    sourcePort: config.IBC_SOURCE_PORT,
    sourceChannel: config.IBC_SOURCE_CHANNEL,
    timeoutSeconds: config.IBC_TIMEOUT_SECONDS,
    orbiter: {
      enabled: config.ORBITER_CCTP_ENABLED,
      feeRecipient: config.ORBITER_FEE_RECIPIENT,
      feeAmount: config.ORBITER_FEE_AMOUNT,
      destinationDomain: config.ORBITER_CCTP_DESTINATION_DOMAIN,
      mintRecipient: config.ORBITER_CCTP_MINT_RECIPIENT,
      destinationCaller: config.ORBITER_CCTP_DESTINATION_CALLER,
      passthroughPayload: config.ORBITER_PASSTHROUGH_PAYLOAD,
    },
  },
  vaults: [
    { id: 'vault-1', name: config.VAULT_1_NAME, address: config.VAULT_1_IBC_RECEIVER || config.VAULT_1_ADDRESS || null, chainType: 'zigchain' },
    { id: 'vault-2', name: config.VAULT_2_NAME, address: config.VAULT_2_IBC_RECEIVER || config.VAULT_2_ADDRESS || null, chainType: 'zigchain' },
    { id: 'vault-3', name: config.VAULT_3_NAME, address: config.VAULT_3_IBC_RECEIVER || config.VAULT_3_ADDRESS || null, chainType: 'zigchain' },
    { id: 'vault-4', name: config.VAULT_4_NAME, address: config.VAULT_4_ADDRESS, chainType: config.VAULT_4_CHAIN_TYPE },
    { id: 'vault-5', name: config.VAULT_5_NAME, address: config.VAULT_5_ADDRESS, chainType: config.VAULT_5_CHAIN_TYPE },
    { id: 'vault-6', name: config.VAULT_6_NAME, address: config.VAULT_6_ADDRESS, chainType: config.VAULT_6_CHAIN_TYPE },
  ],
  blockchainStatus: vaultsConfigured ? 'READY' : 'VAULT_ADDRESSES_NOT_CONFIGURED',
  walletModes: ['private-key'],
  backendSignerEnabled: config.BACKEND_SIGNER_ENABLED,
}));

app.get('/api/wallet/:address/balance', async (request, reply) => {
  const params = z.object({ address: z.string().regex(/^zig1[0-9a-z]{38,62}$/) }).safeParse(request.params);
  const query = z.object({ denom: z.string().min(1).max(160).optional() }).safeParse(request.query);
  if (!params.success) return reply.code(400).send({ code: 'INVALID_ZIG_ADDRESS' });
  if (!query.success) return reply.code(400).send({ code: 'INVALID_BALANCE_QUERY' });
  const denom = query.data.denom ?? config.TOKEN_DENOM;
  const response = await fetch(`${config.API_URL}/cosmos/bank/v1beta1/balances/${params.data.address}/by_denom?denom=${encodeURIComponent(denom)}`);
  if (!response.ok) return reply.code(502).send({ code: 'CHAIN_API_UNAVAILABLE' });
  const data = await response.json() as { balance?: { amount?: string; denom?: string } };
  return { address: params.data.address, amountBaseUnits: data.balance?.amount ?? '0', denom: data.balance?.denom ?? denom };
});

app.get('/api/wallet/:address/transactions', async (request, reply) => {
  const params = z.object({ address: z.string().regex(/^zig1[0-9a-z]{38,62}$/) }).safeParse(request.params);
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
  if (!params.success) return reply.code(400).send({ code: 'INVALID_ZIG_ADDRESS' });
  if (!query.success) return reply.code(400).send({ code: 'INVALID_HISTORY_QUERY' });

  const searchParams = new URLSearchParams({
    query: JSON.stringify(`transfer.sender='${params.data.address}'`),
    prove: 'false',
    page: '1',
    per_page: String(query.data.limit),
    order_by: JSON.stringify('desc'),
  });
  const response = await fetch(`${config.RPC_URL}/tx_search?${searchParams}`);
  if (!response.ok) return reply.code(502).send({ code: 'CHAIN_HISTORY_UNAVAILABLE' });

  type RpcAttribute = { key: string; value: string };
  type RpcEvent = { type: string; attributes: RpcAttribute[] };
  type RpcTx = { hash: string; height: string; tx_result: { code: number; gas_wanted: string; gas_used: string; events: RpcEvent[] } };
  const result = await response.json() as { result?: { txs?: RpcTx[] } };
  const configuredVaultAddresses = [
    config.VAULT_1_IBC_RECEIVER || config.VAULT_1_ADDRESS,
    config.VAULT_2_IBC_RECEIVER || config.VAULT_2_ADDRESS,
    config.VAULT_3_IBC_RECEIVER || config.VAULT_3_ADDRESS,
  ];
  const configuredVaults = new Set(configuredVaultAddresses.filter(Boolean));
  const transactions = (result.result?.txs ?? []).flatMap((tx) => tx.tx_result.events
    .filter((event) => event.type === 'transfer')
    .map((event) => Object.fromEntries(event.attributes.map((attribute) => [attribute.key, attribute.value])))
    .filter((attributes): attributes is Record<'sender' | 'recipient' | 'amount', string> =>
      typeof attributes.sender === 'string'
      && typeof attributes.recipient === 'string'
      && typeof attributes.amount === 'string'
      && attributes.sender === params.data.address
      && configuredVaults.has(attributes.recipient))
    .map((attributes) => ({
      hash: tx.hash,
      height: tx.height,
      sender: attributes.sender,
      recipient: attributes.recipient,
      vaultIndex: configuredVaultAddresses.indexOf(attributes.recipient),
      amountBaseUnits: attributes.amount?.endsWith(config.TOKEN_DENOM) ? attributes.amount.slice(0, -config.TOKEN_DENOM.length) : '0',
      status: tx.tx_result.code === 0 ? 'Success' as const : 'Failed' as const,
      gasWanted: tx.tx_result.gas_wanted,
      gasUsed: tx.tx_result.gas_used,
    })));

  const heights = [...new Set(transactions.map((transaction) => transaction.height))];
  const blockTimes = new Map<string, string>();
  await Promise.all(heights.map(async (height) => {
    try {
      const blockResponse = await fetch(`${config.RPC_URL}/block?height=${encodeURIComponent(height)}`);
      if (!blockResponse.ok) return;
      const block = await blockResponse.json() as { result?: { block?: { header?: { time?: string } } } };
      const timestamp = block.result?.block?.header?.time;
      if (timestamp) blockTimes.set(height, timestamp);
    } catch {
      // Keep the transaction even if its block timestamp cannot be fetched.
    }
  }));

  return { address: params.data.address, transactions: transactions.map((transaction) => ({ ...transaction, timestamp: blockTimes.get(transaction.height) ?? null })) };
});

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
