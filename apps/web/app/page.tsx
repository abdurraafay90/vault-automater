'use client';

import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, type EncodeObject, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coin } from '@cosmjs/stargate';
import { ethers } from 'ethers';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

export type ChainType = 'zigchain' | 'erc' | 'bnb';

export function isEvmChain(chainType?: ChainType): boolean {
  return chainType === 'erc' || chainType === 'bnb';
}

export type VaultAsset = {
  symbol: string;
  name: string;
  decimals: number;
  /** EVM contract address. Mutually exclusive with `denom`. */
  address?: string;
  /** Cosmos bank denom (e.g. an ibc/… hash). Required for ZIGChain assets. */
  denom?: string;
  isNative?: boolean;
  isDetected?: boolean;
  isCustom?: boolean;
};

export type Vault = {
  id?: string;
  pair: string;
  name: string;
  address: string | null;
  chainType: ChainType;
  accent: 'blue' | 'purple' | 'orange' | 'green' | 'cyan' | 'yellow' | 'gold';
  tvl: string;
  apy: string;
  type: string;
  risk: string;
  summary: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  tokenAddress?: string;
  detectedAsset?: VaultAsset | null;
  selectedAssetSymbol?: string;
  customAsset?: VaultAsset | null;
  evmNetwork?: 'mainnet';
};

export interface CsvWalletQueueItem {
  id: string;
  address: string;
  privateKey: string;
  amount: string;
  scheduledTime?: string;
  status: 'Pending' | 'Approving' | 'Depositing' | 'Success' | 'Failed' | 'Cancelled';
  txHash?: string;
  error?: string;
  /** The CSV line itself could not be read reliably; this row is never sent. */
  parseError?: string;
}

type ChainConfig = { name: string; id: string; rpcUrl: string; apiUrl: string; explorerUrl: string };
type EvmConfig = {
  rpcUrl: string;
  chainId: number;
  explorerUrl: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  rpcUrls?: string[];
  wsUrls?: string[];
};
type TokenConfig = { symbol: string; denom: string; decimals: number };
type IbcTransferConfig = {
  sourcePort: string;
  sourceChannel: string;
  timeoutSeconds: number;
  orbiter: {
    enabled: boolean;
    feeRecipient: string;
    feeAmount: string;
    destinationDomain: number;
    mintRecipient: string;
    destinationCaller: string;
    passthroughPayload: string;
  };
};

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const VAULT_DEPOSIT_ABI = [
  'function deposit(uint256 amount) returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
];

// Presets for Ethereum Mainnet (Chain ID 1). USDT/USDC are 6 decimals here.
const MAINNET_USDT: VaultAsset = { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, isDetected: true };
const MAINNET_USDC: VaultAsset = { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 };

// Presets for BNB Smart Chain (Chain ID 56). Binance-Peg stables are 18 decimals.
const BSC_MAINNET_USDT: VaultAsset = { symbol: 'USDT', name: 'Binance-Peg BSC-USD', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, isDetected: true };
const BSC_MAINNET_USDC: VaultAsset = { symbol: 'USDC', name: 'Binance-Peg USD Coin', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 };

// Presets for ZIGChain
// Noble USDC bridged over transfer/channel-3. The ibc/ hash is
// SHA256("transfer/channel-3/uusdc"), which is what the chain indexes it under.
const ZIGCHAIN_USDC_DENOM = 'ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4';
const ZIGCHAIN_USDC: VaultAsset = { symbol: 'USDC', name: 'Noble USDC', decimals: 6, denom: ZIGCHAIN_USDC_DENOM, isDetected: true };

const EVM_RPC_TIMEOUT_MS = 10_000;

type RpcEndpoint = {
  url: string;
  provider: ethers.JsonRpcProvider;
  chainCheck: Promise<void> | null;
  wrongChain: boolean;
};

/**
 * True when the error describes the request itself, so every other endpoint
 * would answer the same way and retrying is pointless (or, for a revert,
 * misleading). Everything else is treated as an endpoint fault and retried.
 */
function isRequestError(error: unknown): boolean {
  if (
    ethers.isError(error, 'INSUFFICIENT_FUNDS')
    || ethers.isError(error, 'NONCE_EXPIRED')
    || ethers.isError(error, 'REPLACEMENT_UNDERPRICED')
    || ethers.isError(error, 'TRANSACTION_REPLACED')
    || ethers.isError(error, 'ACTION_REJECTED')
    || ethers.isError(error, 'INVALID_ARGUMENT')
  ) return true;
  if (ethers.isError(error, 'CALL_EXCEPTION')) {
    // ethers reports ANY JSON-RPC error on eth_call/estimateGas as
    // CALL_EXCEPTION ("missing revert data"), including an endpoint refusing
    // the method (-32601), rate-limiting, or lacking state. Only an actual EVM
    // execution failure means every node would fail the same way.
    const rpcError = (error.info as { error?: { message?: unknown } } | undefined)?.error;
    const message = String(rpcError?.message ?? '');
    const hasRevertData = typeof error.data === 'string' && error.data !== '0x';
    if (hasRevertData) return true;
    if (ENDPOINT_FAULT_PATTERN.test(message)) return false;
    return EVM_EXECUTION_FAILURE_PATTERN.test(message);
  }
  return false;
}

// Node-side problems another endpoint may not have.
const ENDPOINT_FAULT_PATTERN = /header not found|missing trie node|rate.?limit|too many requests|not whitelisted|not supported|method not found|unauthori[sz]ed|forbidden|capacity|timeout|timed out|unavailable|internal error/i;

// The EVM itself failed. Includes `assert`-style failures: mainnet USDT's
// SafeMath uses assert, so an insufficient-balance transfer surfaces as
// "invalid opcode: INVALID" / "EVM error: InvalidFEOpcode", never as "revert".
const EVM_EXECUTION_FAILURE_PATTERN = /revert|invalid opcode|InvalidFEOpcode|EVM error|out of gas|gas required exceeds|stack (?:underflow|overflow)|invalid jump|bad jump destination/i;

/** A node rejecting a broadcast because it already has this exact transaction. */
function isAlreadyBroadcast(error: unknown): boolean {
  const rpcMessage = String(((error as { info?: { error?: { message?: unknown } } })?.info?.error?.message) ?? '');
  return ethers.isError(error, 'NONCE_EXPIRED')
    || /already known|known transaction|already imported/i.test(`${(error as Error)?.message ?? ''} ${rpcMessage}`);
}

/**
 * Tries endpoints strictly in listed order. Used instead of ethers'
 * FallbackProvider, which with quorum 1 treats the first endpoint's *error* as
 * the answer (so a refusing node fails every contract call) and aborts the
 * whole provider if any single URL is on the wrong chain.
 *
 * - Each endpoint's eth_chainId is verified once; a wrong-chain endpoint is
 *   skipped permanently rather than served from.
 * - Endpoint faults (timeouts, HTTP/transport errors, refusals, rate limits)
 *   fall through to the next endpoint.
 * - Request errors (reverts, insufficient funds, nonce) are thrown at once.
 * - Children use staticNetwork, so a dead host fails fast instead of spawning
 *   an endless network-detection retry loop.
 */
class SequentialRpcProvider extends ethers.AbstractProvider {
  readonly #network: ethers.Network;
  readonly #endpoints: RpcEndpoint[];

  constructor(urls: string[], chainId: number) {
    const network = ethers.Network.from(chainId);
    super(network);
    this.#network = network;
    this.#endpoints = urls.map((url) => {
      const request = new ethers.FetchRequest(url);
      request.timeout = EVM_RPC_TIMEOUT_MS;
      return {
        url,
        provider: new ethers.JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1 }),
        chainCheck: null,
        wrongChain: false,
      };
    });
  }

  async _detectNetwork(): Promise<ethers.Network> {
    return this.#network;
  }

  #verifyChain(endpoint: RpcEndpoint): Promise<void> {
    endpoint.chainCheck ??= (async () => {
      const actual = BigInt(await endpoint.provider.send('eth_chainId', []));
      if (actual !== this.#network.chainId) {
        endpoint.wrongChain = true;
        throw new Error(`${endpoint.url} serves chain ${actual}, expected ${this.#network.chainId}.`);
      }
    })().catch((error: unknown) => {
      // A transient failure is re-checked next time; a wrong chain never is.
      if (!endpoint.wrongChain) endpoint.chainCheck = null;
      throw error;
    });
    return endpoint.chainCheck;
  }

  async _perform<T = unknown>(req: ethers.PerformActionRequest): Promise<T> {
    let lastError: unknown = null;
    let broadcastReachedNode = false;
    for (const endpoint of this.#endpoints) {
      if (endpoint.wrongChain) continue;
      let verified = false;
      try {
        await this.#verifyChain(endpoint);
        verified = true;
        return await endpoint.provider._perform(req) as T;
      } catch (error) {
        // An earlier node may have accepted the transaction before its response
        // was lost; this node then reports it as known. It is already sent.
        if (req.method === 'broadcastTransaction' && broadcastReachedNode && isAlreadyBroadcast(error)) {
          return ethers.Transaction.from(req.signedTransaction).hash as T;
        }
        if (verified && isRequestError(error)) throw error;
        if (verified && req.method === 'broadcastTransaction') broadcastReachedNode = true;
        lastError = error;
      }
    }
    throw ethers.makeError(`All RPC endpoints failed for ${req.method}.`, 'NETWORK_ERROR', {
      event: 'rpcFallbackExhausted',
      info: { lastError },
    });
  }

  destroy(): void {
    for (const endpoint of this.#endpoints) endpoint.provider.destroy();
    super.destroy();
  }
}

/** Provider for an EVM config, failing over across its RPC list in order. */
function createEvmProvider(evmConf: EvmConfig): ethers.AbstractProvider {
  const urls = (evmConf.rpcUrls?.length ? evmConf.rpcUrls : [evmConf.rpcUrl]).filter(Boolean);
  return new SequentialRpcProvider(urls, evmConf.chainId);
}

async function inspectErc20Token(tokenAddress: string, evmConf?: EvmConfig): Promise<VaultAsset | null> {
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress.trim())) return null;
  if (!evmConf) return null;
  const cleanAddr = ethers.getAddress(tokenAddress.trim());

  try {
    const provider = createEvmProvider(evmConf);
    const code = await provider.getCode(cleanAddr);
    if (!code || code === '0x') return null;

    const tokenContract = new ethers.Contract(cleanAddr, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      tokenContract.symbol().catch(() => 'TOKEN'),
      tokenContract.name().catch(() => 'Token'),
      tokenContract.decimals().catch(() => 6),
    ]);
    return {
      symbol: String(symbol),
      name: String(name),
      decimals: Number(decimals),
      address: cleanAddr,
      isCustom: true,
    };
  } catch {}
  return null;
}

async function detectVaultAsset(vaultAddress: string, evmConf?: EvmConfig): Promise<VaultAsset | null> {
  if (!vaultAddress || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) return null;
  if (!evmConf) return null;

  try {
    const provider = createEvmProvider(evmConf);
    const code = await provider.getCode(vaultAddress);
    if (!code || code === '0x') return null;

    let tokenAddress = '';
    // Try ERC-4626 asset() -> 0x38d52e0f
    try {
      const assetRes = await provider.call({ to: vaultAddress, data: '0x38d52e0f' });
      if (assetRes && assetRes !== '0x' && assetRes.length >= 66) {
        const addr = '0x' + assetRes.slice(-40);
        if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) {
          tokenAddress = ethers.getAddress(addr);
        }
      }
    } catch {}

    // Fallback: Try token() -> 0xfc0c5465
    if (!tokenAddress) {
      try {
        const tokenRes = await provider.call({ to: vaultAddress, data: '0xfc0c5465' });
        if (tokenRes && tokenRes !== '0x' && tokenRes.length >= 66) {
          const addr = '0x' + tokenRes.slice(-40);
          if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) {
            tokenAddress = ethers.getAddress(addr);
          }
        }
      } catch {}
    }

    if (tokenAddress) {
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [symbol, name, decimals] = await Promise.all([
        tokenContract.symbol().catch(() => 'TOKEN'),
        tokenContract.name().catch(() => 'Vault Token'),
        tokenContract.decimals().catch(() => 6),
      ]);
      return {
        symbol: String(symbol),
        name: String(name),
        decimals: Number(decimals),
        address: tokenAddress,
        isDetected: true,
        isNative: false,
      };
    }
  } catch {}
  return null;
}

function getAvailableAssetsForVault(targetVault: Vault, evmConf: EvmConfig, dynamicAssets: VaultAsset[] = []): VaultAsset[] {
  const list: VaultAsset[] = [];

  // If vault has an auto-detected asset, prioritize it at the top
  if (targetVault.detectedAsset) {
    list.push({ ...targetVault.detectedAsset, isDetected: true });
  }

  // If vault has a bound token address or custom asset, include it
  if (targetVault.tokenAddress) {
    const existing = list.find((a) => a.address?.toLowerCase() === targetVault.tokenAddress?.toLowerCase());
    if (!existing) {
      list.push({
        symbol: targetVault.tokenSymbol || 'TOKEN',
        name: targetVault.tokenSymbol ? `${targetVault.tokenSymbol} (Vault Token)` : 'Custom Token',
        address: targetVault.tokenAddress,
        decimals: targetVault.tokenDecimals ?? 6,
        isCustom: true,
      });
    }
  }

  if (targetVault.customAsset && !list.some((existing) => existing.symbol.toLowerCase() === targetVault.customAsset?.symbol.toLowerCase() || (targetVault.customAsset?.address && existing.address?.toLowerCase() === targetVault.customAsset?.address.toLowerCase()))) {
    list.push(targetVault.customAsset);
  }

  // Stablecoins only. Native gas tokens (ZIG / ETH / BNB) are never offered as
  // a transfer asset — they are held to pay fees.
  if (targetVault.chainType === 'zigchain') {
    // USDC is the only stablecoin bridged to ZIGChain; there is no USDT denom
    // on this chain, so it cannot be offered here.
    if (!list.some((a) => a.symbol === 'USDC')) list.push(ZIGCHAIN_USDC);
    return list.filter((a) => !a.isNative);
  }

  // EVM mainnets: Ethereum (chain 1) and BNB Smart Chain (chain 56)
  if (targetVault.chainType === 'bnb') {
    if (!list.some((a) => a.symbol === 'USDT')) list.push(BSC_MAINNET_USDT);
    if (!list.some((a) => a.symbol === 'USDC')) list.push(BSC_MAINNET_USDC);
  } else {
    if (!list.some((a) => a.symbol === 'USDT')) list.push(MAINNET_USDT);
    if (!list.some((a) => a.symbol === 'USDC')) list.push(MAINNET_USDC);
  }

  // A vault's tokenSymbol is NOT added as an asset on its own: without a token
  // contract address it cannot be transferred, and the execution path would
  // treat an address-less asset as a native ETH/BNB send. A token with an
  // address is already included above via tokenAddress / customAsset.

  // Add any dynamically discovered wallet assets with positive balance
  for (const item of dynamicAssets) {
    if (!list.some((existing) => existing.symbol.toLowerCase() === item.symbol.toLowerCase() || (item.address && existing.address?.toLowerCase() === item.address?.toLowerCase()))) {
      list.push(item);
    }
  }

  // Stablecoin tokens only: never a native gas token, and never an EVM asset
  // without a contract address to call.
  return list.filter((a) => !a.isNative && !!a.address);
}

function getActiveVaultAsset(targetVault: Vault, evmConf: EvmConfig, dynamicAssets: VaultAsset[] = []): VaultAsset {
  const available = getAvailableAssetsForVault(targetVault, evmConf, dynamicAssets);
  if (targetVault.selectedAssetSymbol) {
    const matched = available.find((a) => a.symbol.toLowerCase() === targetVault.selectedAssetSymbol?.toLowerCase());
    if (matched) return matched;
  }
  if (targetVault.detectedAsset) {
    return targetVault.detectedAsset;
  }
  if (targetVault.tokenAddress) {
    const matched = available.find((a) => a.address?.toLowerCase() === targetVault.tokenAddress?.toLowerCase());
    if (matched) return matched;
  }
  if (targetVault.tokenSymbol) {
    const matched = available.find((a) => a.symbol.toLowerCase() === targetVault.tokenSymbol?.toLowerCase());
    if (matched) return matched;
  }
  return available[0]!;
}

type AutomationStatus = 'stopped' | 'running' | 'paused';
type DeliveryMode = 'once' | 'automation';
type Automation = {
  mode: DeliveryMode;
  minimum: string;
  maximum: string;
  interval: number;
  customInterval: string;
  status: AutomationStatus;
  lastAt: number | null;
  nextAt: number | null;
  /** Id of the server-side automation executing this schedule, if any. */
  serverId?: string | null;
  lastError?: string | null;
  /** The worker is sending for this vault right now. */
  inFlight?: boolean;
};

// Server-side automation state (GET /api/automation/state). Execution happens
// in the worker process, so schedules continue with this tab closed.
type ServerAutomation = {
  id: string;
  vaultKey: string;
  status: 'running' | 'paused' | 'stopped';
  minAmount: string;
  maxAmount: string;
  intervalSeconds: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  inFlightSince: number | null;
  createdAt: number;
};
type ServerRun = {
  id: string;
  vaultKey: string;
  amountBaseUnits: string;
  status: 'pending' | 'success' | 'failed';
  txHash: string | null;
  error: string | null;
  startedAt: number;
};
type ServerBatchRow = { rowIndex: number; walletAddress: string; amount: string; status: 'pending' | 'sending' | 'success' | 'failed' | 'cancelled'; txHash: string | null; error: string | null };
type ServerBatch = { id: string; vaultKey: string; status: 'running' | 'completed' | 'cancelled'; delaySeconds: number; rows: ServerBatchRow[] };
type AutomationServerState = {
  workerOnline: boolean;
  encryptionConfigured: boolean;
  automations: ServerAutomation[];
  batches: ServerBatch[];
  runs: ServerRun[];
};

/** Stable identity for a vault across reloads, shared with the server. */
function vaultKeyOf(vault: Vault): string {
  return vault.id ? vault.id : `${vault.chainType}:${(vault.address ?? '').toLowerCase()}`;
}

const BATCH_ROW_STATUS: Record<ServerBatchRow['status'], CsvWalletQueueItem['status']> = {
  pending: 'Pending',
  sending: 'Depositing',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// TokenX vault TVL (GET /api/vault-stats). Read-only, refreshed server-side
// every VAULT_STATS_REFRESH_MINUTES (default 30) directly from vaultStats().
type VaultStatsEntry = {
  vaultKey: string;
  vaultName: string;
  chainType: 'erc' | 'bnb';
  tvlBaseUnits: string | null;
  assetSymbol: string | null;
  assetDecimals: number | null;
  isPaused: boolean | null;
  updatedAt: number | null;
  error: string | null;
};
type VaultStatsResponse = { refreshMinutes: number; vaults: VaultStatsEntry[] };

async function readApiError(response: Response): Promise<string> {
  const data = await response.json().catch(() => ({})) as { code?: string; message?: string; rows?: { row: number; error: string }[] };
  if (response.status === 401) return 'Your session has expired. Log in again.';
  return data.message || data.code || `Request failed (HTTP ${response.status}).`;
}
type HistoryStatus = 'Pending' | 'Success' | 'Failed';
type HistoryEntry = { id: string; vaultIndex: number; time: number; amountBaseUnits: bigint; status: HistoryStatus; hash?: string; error?: string; source: 'Manual' | 'Automation' | 'Chain' };
type AuthUser = { id: string; email: string; role: 'ADMIN' | 'USER'; active: boolean; createdAt: string };
type WalletSession = { mode: 'private'; source: 'private' | null; address: string; manualAddress: string; balanceBaseUnits: string; nativeGasBaseUnits: string; error: string; connecting: boolean; unlocking: boolean; hasSigner: boolean };

type UniversalSigner =
  | { type: 'cosmos'; signer: OfflineSigner }
  | { type: 'evm'; wallet: ethers.Wallet; provider: ethers.AbstractProvider };

const defaultChainConfig: ChainConfig = {
  name: 'ZIGChain',
  id: 'zigchain-1',
  rpcUrl: 'https://zigchain-mainnet.zigscan.net',
  apiUrl: 'https://zigchain-mainnet-lcd.zigscan.net',
  explorerUrl: 'https://zigscan.org',
};

// Keyless public mainnet RPCs. Index 0 is primary, the rest are ordered
// fallbacks used by createEvmProvider. Overridden by the API's /config/public.
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

const defaultEvmMainnetConfig: EvmConfig = {
  rpcUrl: DEFAULT_ETH_RPC_URLS[0]!,
  chainId: 1,
  explorerUrl: 'https://etherscan.io',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: DEFAULT_ETH_RPC_URLS,
  wsUrls: ['wss://ethereum-rpc.publicnode.com'],
};

const defaultBnbMainnetConfig: EvmConfig = {
  rpcUrl: DEFAULT_BSC_RPC_URLS[0]!,
  chainId: 56,
  explorerUrl: 'https://bscscan.com',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: DEFAULT_BSC_RPC_URLS,
  wsUrls: ['wss://bsc-rpc.publicnode.com'],
};

function getVaultEvmConfig(
  targetVault?: Vault | null,
  mainnetEvm: EvmConfig = defaultEvmMainnetConfig,
  bnbMainnetEvm: EvmConfig = defaultBnbMainnetConfig,
): EvmConfig {
  if (targetVault?.chainType === 'bnb') return bnbMainnetEvm;
  return mainnetEvm;
}


const defaultTokenConfig: TokenConfig = { symbol: 'ZIG', denom: 'uzig', decimals: 6 };

const defaultIbcTransferConfig: IbcTransferConfig = {
  sourcePort: 'transfer',
  sourceChannel: 'channel-3',
  timeoutSeconds: 600,
  orbiter: { enabled: false, feeRecipient: '', feeAmount: '', destinationDomain: 0, mintRecipient: '', destinationCaller: '', passthroughPayload: '' },
};

const defaultVaults: Vault[] = [
  {
    pair: 'PAIR 1',
    name: 'Stablecoin Yield',
    address: 'Not configured',
    chainType: 'zigchain',
    accent: 'blue',
    tvl: '$39,717,012',
    apy: '9.95%',
    type: 'Stablecoin Yield',
    risk: 'Low',
    summary: 'Low-risk stablecoin strategy on ZIGChain (USDC)',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    detectedAsset: ZIGCHAIN_USDC,
    selectedAssetSymbol: 'USDC',
  },
  {
    pair: 'PAIR 2',
    name: 'Opportunistic Credit',
    address: 'Not configured',
    chainType: 'zigchain',
    accent: 'purple',
    tvl: '$16,679,657',
    apy: '10.32%',
    type: 'Opportunistic',
    risk: 'Low',
    summary: 'Diversified private credit strategy on ZIGChain (USDC)',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    detectedAsset: ZIGCHAIN_USDC,
    selectedAssetSymbol: 'USDC',
  },
  {
    pair: 'PAIR 3',
    name: 'Core Income',
    address: 'Not configured',
    chainType: 'zigchain',
    accent: 'orange',
    tvl: '$11,329,834',
    apy: '8.03%',
    type: 'Core Income',
    risk: 'Low',
    summary: 'Lower-volatility private credit strategy on ZIGChain',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    detectedAsset: ZIGCHAIN_USDC,
    selectedAssetSymbol: 'USDC',
  },
  {
    pair: 'ERC 1',
    name: 'Valdora',
    address: '0x1754fCD1F0EBb306286dd16F00abCf46731a92FC',
    chainType: 'erc',
    evmNetwork: 'mainnet',
    accent: 'cyan',
    tvl: '$18,320,000',
    apy: '11.85%',
    type: 'Liquid Staking & Yield',
    risk: 'Medium',
    summary: 'Composable institutional liquid staking & yield vault (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 6,
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    detectedAsset: MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
  {
    pair: 'ERC 2',
    name: 'NAWA',
    address: '0x3c7C22d108ddbD8190f3CAa3A5BCd99cBD8469e2',
    chainType: 'erc',
    evmNetwork: 'mainnet',
    accent: 'green',
    tvl: '$24,850,000',
    apy: '12.40%',
    type: 'Shariah Ethical Yield',
    risk: 'Low',
    summary: 'Shariah-compliant ethical asset-backed yield wallet (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 6,
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    detectedAsset: MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
  {
    pair: 'ERC 3',
    name: 'TokenX main wallet',
    address: '0xe6C1ae22207DCe5C5fE66BEC7A314aa0B55C3e51',
    chainType: 'erc',
    evmNetwork: 'mainnet',
    accent: 'purple',
    tvl: '$0',
    apy: '—',
    type: 'Treasury Wallet',
    risk: 'Low',
    summary: 'TokenX main treasury wallet on Ethereum mainnet (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 6,
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    detectedAsset: MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
  {
    pair: 'ERC 4',
    name: 'TokenX admin wallet',
    address: '0x1dA18CeEDf24dEb656FB85ee40f49c3f698b13c0',
    chainType: 'erc',
    evmNetwork: 'mainnet',
    accent: 'orange',
    tvl: '$0',
    apy: '—',
    type: 'Treasury Wallet',
    risk: 'Low',
    summary: 'TokenX admin treasury wallet on Ethereum mainnet (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 6,
    tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    detectedAsset: MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
  {
    pair: 'BNB 1',
    name: 'TokenX main wallet',
    address: '0xe6C1ae22207DCe5C5fE66BEC7A314aa0B55C3e51',
    chainType: 'bnb',
    evmNetwork: 'mainnet',
    accent: 'yellow',
    tvl: '$0',
    apy: '—',
    type: 'Treasury Wallet',
    risk: 'Low',
    summary: 'TokenX main treasury wallet on BNB Smart Chain (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 18,
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    detectedAsset: BSC_MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
  {
    pair: 'BNB 2',
    name: 'TokenX admin wallet',
    address: '0x1dA18CeEDf24dEb656FB85ee40f49c3f698b13c0',
    chainType: 'bnb',
    evmNetwork: 'mainnet',
    accent: 'gold',
    tvl: '$0',
    apy: '—',
    type: 'Treasury Wallet',
    risk: 'Low',
    summary: 'TokenX admin treasury wallet on BNB Smart Chain (USDT)',
    tokenSymbol: 'USDT',
    tokenDecimals: 18,
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    detectedAsset: BSC_MAINNET_USDT,
    selectedAssetSymbol: 'USDT',
  },
];

const intervals = [
  { label: '2s', value: 2 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
];

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';
const GAS_MULTIPLIER = 1.5;
const BIGINT_ZERO = BigInt(0);
const BIGINT_TEN = BigInt(10);
const MILLISECONDS_TO_NANOSECONDS = BigInt(1000000);

function apiRequest(path: string, init: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, { ...init, credentials: 'include' });
}

function formatBaseUnits(value: string | bigint, decimals = 6) {
  const padded = value.toString().padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}

function baseUnitMultiplier(decimals: number) {
  return BIGINT_TEN ** BigInt(decimals);
}

function parseTokenAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  // Commas are accepted only as well-formed thousands separators ("1,000.5").
  // Stripping them blindly turned a decimal comma ("1,5" meaning 1.5) into 15.
  if (trimmed.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Use "." for decimals; commas are only allowed as thousands separators (e.g. 1,000.5).');
  }
  const normalized = trimmed.replaceAll(',', '');
  const amountPattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!amountPattern.test(normalized)) throw new Error(`Enter a valid amount with no more than ${decimals} decimals.`);
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * baseUnitMultiplier(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= BIGINT_ZERO) throw new Error('Transfer amount must be greater than zero.');
  return amount;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error('Use a 32-byte hex private key or a 12/24-word mnemonic.');
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function formatCountdown(nextAt: number | null, now: number) {
  if (!nextAt) return '—';
  const seconds = Math.max(0, Math.ceil((nextAt - now) / 1000));
  if (seconds === 0) return 'Due now';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBlockchainError(error: unknown, chainType: ChainType, symbol = 'ETH'): string {
  if (!error) return 'Transfer failed.';
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code || '';
  const reason = (error as { reason?: string })?.reason || '';

  // If already a clean pre-flight message, preserve it
  if (/^Insufficient (funds|balance):/i.test(raw)) {
    return raw;
  }

  // Every configured RPC endpoint failed. Checked first: the message names the
  // failed method (e.g. "estimateGas"), which must not read as a revert below.
  if (code === 'NETWORK_ERROR' && raw.startsWith('All RPC endpoints failed')) {
    return 'Network connection error: every configured RPC endpoint failed. Check your internet connection or the RPC list in .env.';
  }

  // A contract revert. A lack of gas money is reported by ethers as
  // INSUFFICIENT_FUNDS (handled below), never as CALL_EXCEPTION, so a revert
  // must not be described as a gas shortage.
  if (
    code === 'CALL_EXCEPTION' ||
    raw.includes('CALL_EXCEPTION') ||
    raw.includes('missing revert data')
  ) {
    if (reason) return `Transaction reverted by the contract: ${reason}.`;
    return `Transaction reverted by the contract with no reason given. Check the vault accepts deposits, the ${symbol} allowance, and your ${symbol} balance.`;
  }

  // Insufficient funds / balance
  if (
    code === 'INSUFFICIENT_FUNDS' ||
    /insufficient\s+funds/i.test(raw) ||
    /insufficient\s+balance/i.test(raw) ||
    /insufficient\s+fee/i.test(raw) ||
    /smaller\s+than/i.test(raw) ||
    /exceeds\s+balance/i.test(raw) ||
    /gas\s*\*\s*price\s*\+\s*value/i.test(raw)
  ) {
    return `Insufficient balance: Your wallet does not have enough ${symbol} to cover the transfer amount plus network gas fees.`;
  }

  // Nonce / Sequence errors
  if (
    code === 'NONCE_EXPIRED' ||
    /nonce\s+too\s+low/i.test(raw) ||
    /replacement\s+underpriced/i.test(raw) ||
    /account\s+sequence\s+mismatch/i.test(raw) ||
    /incorrect\s+account\s+sequence/i.test(raw)
  ) {
    return 'Transaction sequence error: A previous transaction is still pending on the network. Please wait a moment and retry.';
  }

  // Gas estimation failure / Out of gas / Intrinsic gas
  if (
    code === 'UNPREDICTABLE_GAS_LIMIT' ||
    /out\s+of\s+gas/i.test(raw) ||
    /intrinsic\s+gas\s+too\s+low/i.test(raw) ||
    /gas\s+limit/i.test(raw)
  ) {
    return `Gas estimation failed: The network cannot simulate this transaction. Verify your ${symbol} balance and that the target address is valid.`;
  }

  // User rejection
  if (code === 'ACTION_REJECTED' || /user\s+rejected/i.test(raw) || /user\s+denied/i.test(raw)) {
    return 'Transaction was cancelled by the user.';
  }

  // Network / RPC connection issues
  if (
    code === 'NETWORK_ERROR' ||
    code === 'SERVER_ERROR' ||
    code === 'TIMEOUT' ||
    /ETIMEDOUT|ECONNREFUSED|fetch\s+failed|502|503|504|Gateway|rate\s*limit|429|connection\s+refused/i.test(raw)
  ) {
    return 'Network connection error: The blockchain RPC node is unreachable or timed out. Please check your internet or RPC settings.';
  }

  // Invalid address format / Bech32 / Checksum
  if (
    code === 'INVALID_ARGUMENT' ||
    /bad\s+address/i.test(raw) ||
    /invalid\s+address/i.test(raw) ||
    /checksum/i.test(raw) ||
    /decoding\s+bech32/i.test(raw)
  ) {
    return 'Invalid destination address format. Please verify the vault recipient address.';
  }

  // Contract revert with specific reason
  if (reason) {
    return `Transaction reverted: ${reason}`;
  }

  // Clean short messages
  if (!raw.includes('{') && !raw.includes('(') && raw.length < 140) {
    return raw;
  }

  // Strip raw JSON dumps from ethers or CosmJS
  if (raw.includes('{') && raw.includes('}')) {
    const cleaned = raw.replace(/\{[\S\s]*\}/g, '').replace(/\(action=[\S\s]*\)/g, '').trim();
    const chainName = chainType === 'bnb' ? 'BNB Chain' : chainType === 'erc' ? 'Ethereum / EVM' : 'ZIGChain';
    return `Transaction failed on ${chainName}. Please verify your wallet balance and network gas.`;
  }

  if (raw.length > 180) {
    return `${raw.slice(0, 177)}...`;
  }

  return raw;
}

function createInitialAutomations(count: number): Automation[] {
  return Array.from({ length: count }, () => ({ mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null }));
}

function createInitialWalletSessions(count: number): WalletSession[] {
  return Array.from({ length: count }, () => ({ mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false }));
}

function unixNow() { return Date.now(); }

function hasValidRange(settings: Automation, decimals = defaultTokenConfig.decimals) {
  try {
    const minimum = parseTokenAmount(settings.minimum, decimals);
    if (settings.mode === 'once') return minimum > BIGINT_ZERO;
    const maximum = settings.maximum.trim() ? parseTokenAmount(settings.maximum, decimals) : minimum;
    if (settings.customInterval.trim()) {
      const cust = Number(settings.customInterval.trim());
      if (Number.isNaN(cust) || cust < 1) return false;
    }
    return maximum >= minimum && Number.isInteger(settings.interval) && settings.interval >= 1;
  } catch {
    return false;
  }
}

/** Splits one CSV line into fields, honouring double-quoted fields ("1,000.50"). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(field); field = ''; }
    else field += char;
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

const CSV_COLUMNS = 4; // wallet_address, private_key, amount, scheduled_time

/**
 * Every data line becomes a queue row. A row that cannot be read reliably is
 * kept and marked Failed with its reason (and never sent), instead of being
 * dropped silently or blocking the other rows.
 */
function parseWalletCsv(text: string): CsvWalletQueueItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const items: CsvWalletQueueItem[] = [];
  const firstLineLower = lines[0]!.toLowerCase();
  const startIndex = firstLineLower.includes('wallet_address') || firstLineLower.includes('address') || firstLineLower.includes('wallet') ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    if (cols.every((col) => !col)) continue; // a line of only commas
    const [address = '', privateKey = '', amount = '', scheduledTime = ''] = cols;
    // An unquoted amount like 1,000.50 splits across columns; reading it as
    // "1" would send the wrong amount, so the row is refused instead. The
    // split can land in the unused scheduled_time column (e.g. with a trailing
    // comma), so also catch a 1-3 digit amount followed by a "000[.xx]" piece.
    const tooManyColumns = cols.length > CSV_COLUMNS && cols.slice(CSV_COLUMNS).some(Boolean);
    const splitThousands = /^\d{1,3}$/.test(amount) && /^\d{3}(\.\d+)?$/.test(cols[3] ?? '');
    const parseError = tooManyColumns || splitThousands
      ? `Line ${i + 1}: the amount looks split by a comma (read "${amount}", then "${cols[3] ?? ''}"). Put amounts with commas in quotes, e.g. "1,000.50", or write 1000.50.`
      : undefined;
    items.push({
      id: `csv-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      address,
      privateKey,
      amount,
      scheduledTime: scheduledTime || undefined,
      status: parseError ? 'Failed' : 'Pending',
      ...(parseError ? { error: parseError, parseError } : {}),
    });
  }
  return items;
}

export default function Home() {
  const [vaults, setVaults] = useState<Vault[]>(defaultVaults);
  const [chainConfig, setChainConfig] = useState<ChainConfig>(defaultChainConfig);
  const [evmMainnetConfig, setEvmMainnetConfig] = useState<EvmConfig>(defaultEvmMainnetConfig);
  const [bnbMainnetConfig, setBnbMainnetConfig] = useState<EvmConfig>(defaultBnbMainnetConfig);
  const [transferToken, setTransferToken] = useState<TokenConfig>(defaultTokenConfig);
  const [nativeToken, setNativeToken] = useState<TokenConfig>(defaultTokenConfig);
  const [ibcTransfer, setIbcTransfer] = useState<IbcTransferConfig>(defaultIbcTransferConfig);
  const [automations, setAutomations] = useState<Automation[]>(() => createInitialAutomations(defaultVaults.length));
  const [selectedVault, setSelectedVault] = useState(0);
  const [walletSessions, setWalletSessions] = useState<WalletSession[]>(() => createInitialWalletSessions(defaultVaults.length));
  const [historyFilter, setHistoryFilter] = useState('All');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sendingVaults, setSendingVaults] = useState<number[]>([]);
  const [transferStatus, setTransferStatus] = useState<{ kind: 'success' | 'error'; message: string; hash?: string } | null>(null);
  const [now, setNow] = useState(unixNow);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [companyUsers, setCompanyUsers] = useState<AuthUser[]>([]);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [adminMessage, setAdminMessage] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [copiedHash, setCopiedHash] = useState('');

  // Add Vault Modal & Sidebar State
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarFilter, setSidebarFilter] = useState<'all' | 'zigchain' | 'erc' | 'bnb'>('all');
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultChain, setNewVaultChain] = useState<ChainType>('zigchain');
  const [newVaultAddress, setNewVaultAddress] = useState('');
  const [newVaultSummary, setNewVaultSummary] = useState('');
  const [newVaultSymbol, setNewVaultSymbol] = useState('');
  const [newVaultDecimals, setNewVaultDecimals] = useState('');
  const [newVaultTokenAddress, setNewVaultTokenAddress] = useState('');
  const [inspectingToken, setInspectingToken] = useState(false);
  const [inspectedTokenInfo, setInspectedTokenInfo] = useState<VaultAsset | null>(null);
  const [walletDiscoveredAssets, setWalletDiscoveredAssets] = useState<VaultAsset[]>([]);
  const walletDiscoveredAssetsRef = useRef<VaultAsset[]>([]);
  const [addVaultError, setAddVaultError] = useState('');
  const [savingVault, setSavingVault] = useState(false);
  const [detectedAddVaultAsset, setDetectedAddVaultAsset] = useState<VaultAsset | null>(null);
  const [detectingAsset, setDetectingAsset] = useState(false);

  // Delete Vault Modal State
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [vaultToDelete, setVaultToDelete] = useState<{ index: number; vault: Vault } | null>(null);
  const [deletingVault, setDeletingVault] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // CSV Batch Wallets State
  const [signerMode, setSignerMode] = useState<'single' | 'csv'>('single');
  const [csvQueue, setCsvQueue] = useState<CsvWalletQueueItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchActiveIndex, setBatchActiveIndex] = useState<number | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);

  const secretInputRef = useRef<HTMLInputElement>(null);
  const signersRef = useRef<Record<number, UniversalSigner | null>>({});
  const walletSessionsRef = useRef<WalletSession[]>(walletSessions);
  const vaultsRef = useRef<Vault[]>(defaultVaults);
  const chainConfigRef = useRef<ChainConfig>(defaultChainConfig);
  const evmMainnetConfigRef = useRef<EvmConfig>(defaultEvmMainnetConfig);
  const bnbMainnetConfigRef = useRef<EvmConfig>(defaultBnbMainnetConfig);
  const transferTokenRef = useRef<TokenConfig>(defaultTokenConfig);
  const nativeTokenRef = useRef<TokenConfig>(defaultTokenConfig);
  const ibcTransferRef = useRef<IbcTransferConfig>(defaultIbcTransferConfig);
  const automationsRef = useRef<Automation[]>(automations);
  const transferQueueRef = useRef<Record<number, Promise<boolean>>>({});
  // The unlocked key, kept in memory only so it can be handed to the server
  // when an automation starts (the in-memory signer cannot export it).
  const signerSecretsRef = useRef<Record<number, string>>({});
  const [serverState, setServerState] = useState<AutomationServerState | null>(null);
  const [vaultStats, setVaultStats] = useState<VaultStatsResponse | null>(null);
  // Which submitted batch the CSV queue is showing, and which queue rows it sent.
  const batchRowMapRef = useRef<{ batchId: string; vaultKey: string; queueIndexes: number[] } | null>(null);
  const seenRunIdsRef = useRef<Set<string> | null>(null);
  const selectedVaultRef = useRef(selectedVault);
  selectedVaultRef.current = selectedVault;
  const sessionGenerationRef = useRef<Record<number, number>>({});

  const vault = vaults[selectedVault] ?? vaults[0];
  const automation = automations[selectedVault] ?? { mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null };
  const walletSession = walletSessions[selectedVault] ?? { mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false };

  const currentVaultEvmConfig = getVaultEvmConfig(vault, evmMainnetConfig, bnbMainnetConfig);
  const activeVaultAsset = getActiveVaultAsset(vault, currentVaultEvmConfig, walletDiscoveredAssets);
  const currentTokenSymbol = activeVaultAsset.symbol;
  const currentTokenDecimals = activeVaultAsset.decimals;
  const availableVaultAssets = getAvailableAssetsForVault(vault, currentVaultEvmConfig, walletDiscoveredAssets);

  function handleSelectVaultAsset(vaultIndex: number, asset: VaultAsset) {
    setVaults((cur) =>
      cur.map((v, i) => {
        if (i !== vaultIndex) return v;
        return {
          ...v,
          selectedAssetSymbol: asset.symbol,
          tokenSymbol: asset.symbol,
          tokenDecimals: asset.decimals,
          tokenAddress: asset.address,
        };
      })
    );
    const targetVault = vaultsRef.current[vaultIndex];
    if (targetVault) {
      vaultsRef.current[vaultIndex] = {
        ...targetVault,
        selectedAssetSymbol: asset.symbol,
        tokenSymbol: asset.symbol,
        tokenDecimals: asset.decimals,
        tokenAddress: asset.address,
      };
    }
    const sess = walletSessionsRef.current[vaultIndex];
    if (sess?.address) {
      void loadBalance(vaultIndex, sess.address);
    }
  }

  // Live ERC/BEP-4626 asset auto-detection when adding an EVM vault
  useEffect(() => {
    if (!isEvmChain(newVaultChain) || !/^0x[0-9a-fA-F]{40}$/.test(newVaultAddress.trim())) {
      setDetectedAddVaultAsset(null);
      return;
    }
    let active = true;
    setDetectingAsset(true);
    const timer = setTimeout(async () => {
      try {
        const targetEvm = newVaultChain === 'bnb'
          ? bnbMainnetConfigRef.current
          : evmMainnetConfigRef.current;
        const detected = await detectVaultAsset(newVaultAddress.trim(), targetEvm);
        if (active) {
          setDetectedAddVaultAsset(detected);
          if (detected) {
            setNewVaultSymbol(detected.symbol);
            setNewVaultDecimals(String(detected.decimals));
          }
        }
      } catch {
        if (active) setDetectedAddVaultAsset(null);
      } finally {
        if (active) setDetectingAsset(false);
      }
    }, 450);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [newVaultAddress, newVaultChain]);

  // Live ERC-20 / BEP-20 token inspection when specifying custom token address in Add Vault modal
  useEffect(() => {
    if (!isEvmChain(newVaultChain) || !/^0x[0-9a-fA-F]{40}$/.test(newVaultTokenAddress.trim())) {
      setInspectedTokenInfo(null);
      return;
    }
    let active = true;
    setInspectingToken(true);
    const timer = setTimeout(async () => {
      try {
        const targetEvm = newVaultChain === 'bnb'
          ? bnbMainnetConfigRef.current
          : evmMainnetConfigRef.current;
        const inspected = await inspectErc20Token(newVaultTokenAddress.trim(), targetEvm);
        if (active) {
          setInspectedTokenInfo(inspected);
          if (inspected) {
            setNewVaultSymbol(inspected.symbol);
            setNewVaultDecimals(String(inspected.decimals));
          }
        }
      } catch {
        if (active) setInspectedTokenInfo(null);
      } finally {
        if (active) setInspectingToken(false);
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [newVaultTokenAddress, newVaultChain]);

  // Dynamically auto-detect accepted token for currently selected vault if it doesn't have detectedAsset yet
  useEffect(() => {
    if (!isEvmChain(vault?.chainType) || !vault?.address || !/^0x[0-9a-fA-F]{40}$/.test(vault.address) || vault.detectedAsset) {
      return;
    }
    let active = true;
    void (async () => {
      try {
        const vaultEvm = getVaultEvmConfig(vault, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
        const detected = await detectVaultAsset(vault.address!, vaultEvm);
        if (active && detected) {
          setVaults((cur) =>
            cur.map((v, i) =>
              i === selectedVault
                ? {
                    ...v,
                    detectedAsset: detected,
                    tokenSymbol: detected.symbol,
                    tokenDecimals: detected.decimals,
                    tokenAddress: detected.address,
                    selectedAssetSymbol: v.selectedAssetSymbol || detected.symbol,
                  }
                : v
            )
          );
        }
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, [selectedVault, vault?.address, vault?.chainType, vault?.detectedAsset, vault?.evmNetwork]);

  const selectedHistory = useMemo(() => history.filter((entry) => entry.vaultIndex === selectedVault && (historyFilter === 'All' || entry.status === historyFilter)), [history, historyFilter, selectedVault]);
  const successfulHistory = history.filter((entry) => entry.vaultIndex === selectedVault && entry.status === 'Success');
  const totalTransferred = successfulHistory.reduce((sum, entry) => sum + entry.amountBaseUnits, BIGINT_ZERO);
  const anyRunning = automations.some((item) => item.status === 'running');
  const anyActive = automations.some((item) => item.status !== 'stopped');

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiRequest('/api/auth/me');
        if (!response.ok) return;
        const data = await response.json() as { user: AuthUser };
        setAuthUser(data.user);
        await loadPublicConfig();
      } catch {
        setAuthUser(null);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    // Display clock only (countdowns). Scheduling itself runs in the worker.
    const ticker = window.setInterval(() => setNow(unixNow()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  // Mirror server-side automation state into the console. Polling (not the
  // tab) is all that stops when the tab closes; the worker keeps sending.
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await apiRequest('/api/automation/state');
        if (!response.ok || cancelled) return;
        applyServerState(await response.json() as AutomationServerState);
      } catch {
        // Transient; the next poll retries.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // applyServerState reads only refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  // TokenX vault TVL. The backend only refreshes every ~30 minutes, so a 60s
  // client poll is just to pick that up promptly — not a live feed.
  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await apiRequest('/api/vault-stats');
        if (!response.ok || cancelled) return;
        setVaultStats(await response.json() as VaultStatsResponse);
      } catch {
        // Transient; the next poll retries.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authUser]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (deleteModalOpen) {
          setDeleteModalOpen(false);
          setVaultToDelete(null);
        } else if (addVaultOpen) {
          setAddVaultOpen(false);
        } else if (sidebarOpen) {
          setSidebarOpen(false);
        } else if (adminOpen) {
          setAdminOpen(false);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addVaultOpen, sidebarOpen, adminOpen, deleteModalOpen]);

  function patchAutomation(index: number, patch: Partial<Automation>) {
    const cur = automationsRef.current;
    const targetLen = Math.max(cur.length, index + 1);
    const expanded = Array.from({ length: targetLen }, (_, i) => cur[i] ?? { mode: 'once', minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped', lastAt: null, nextAt: null });
    const next = expanded.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    automationsRef.current = next;
    setAutomations(next);
  }

  function patchWalletSession(index: number, patch: Partial<WalletSession>) {
    const cur = walletSessionsRef.current;
    const targetLen = Math.max(cur.length, index + 1);
    const expanded = Array.from({ length: targetLen }, (_, i) => cur[i] ?? { mode: 'private', source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false });
    const next = expanded.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
    walletSessionsRef.current = next;
    setWalletSessions(next);
  }

  function applyServerState(data: AutomationServerState) {
    setServerState(data);
    const currentVaults = vaultsRef.current;
    const indexByKey = new Map(currentVaults.map((v, i) => [vaultKeyOf(v), i] as const));

    // Automations: the newest server automation per vault drives that vault's panel.
    currentVaults.forEach((targetVault, index) => {
      const key = vaultKeyOf(targetVault);
      const server = data.automations
        .filter((item) => item.vaultKey === key)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const local = automationsRef.current[index];
      if (server && server.status !== 'stopped') {
        const presetInterval = intervals.some((option) => option.value === server.intervalSeconds);
        const patch: Partial<Automation> = {
          mode: 'automation',
          status: server.status,
          nextAt: server.nextRunAt,
          lastAt: server.lastRunAt,
          serverId: server.id,
          lastError: server.lastError,
          inFlight: server.inFlightSince !== null,
          minimum: server.minAmount,
          maximum: server.maxAmount,
          interval: server.intervalSeconds,
          customInterval: presetInterval ? '' : String(server.intervalSeconds),
        };
        const changed = !local || (Object.keys(patch) as (keyof Automation)[]).some((field) => local[field] !== patch[field]);
        if (changed) {
          // Surface a failure that paused the selected vault's schedule.
          if (local?.status === 'running' && server.status === 'paused' && server.lastError && index === selectedVaultRef.current) {
            setTransferStatus({ kind: 'error', message: `Automation paused: ${server.lastError}` });
          }
          patchAutomation(index, patch);
        }
      } else if (local?.serverId) {
        patchAutomation(index, { status: 'stopped', nextAt: null, serverId: null, inFlight: false, lastAt: server?.lastRunAt ?? local.lastAt, lastError: server?.lastError ?? null });
      }
    });

    // Run history from the server replaces earlier server entries.
    const runEntries: HistoryEntry[] = data.runs.flatMap((run) => {
      const vaultIndex = indexByKey.get(run.vaultKey);
      if (vaultIndex === undefined) return [];
      return [{
        id: `run-${run.id}`,
        vaultIndex,
        time: run.startedAt,
        amountBaseUnits: BigInt(run.amountBaseUnits),
        status: run.status === 'success' ? 'Success' : run.status === 'failed' ? 'Failed' : 'Pending',
        ...(run.txHash ? { hash: run.txHash } : {}),
        ...(run.error ? { error: run.error } : {}),
        source: 'Automation',
      } satisfies HistoryEntry];
    });
    setHistory((current) => [...runEntries, ...current.filter((entry) => !entry.id.startsWith('run-'))]
      .sort((a, b) => b.time - a.time)
      .slice(0, 200));

    // Refresh a wallet's balance when a server send for its vault succeeds.
    const successIds = data.runs.filter((run) => run.status === 'success').map((run) => run.id);
    if (seenRunIdsRef.current) {
      for (const run of data.runs) {
        if (run.status !== 'success' || seenRunIdsRef.current.has(run.id)) continue;
        const vaultIndex = indexByKey.get(run.vaultKey);
        const address = vaultIndex === undefined ? '' : walletSessionsRef.current[vaultIndex]?.address;
        if (vaultIndex !== undefined && address) void loadBalance(vaultIndex, address);
      }
    }
    seenRunIdsRef.current = new Set(successIds);

    // CSV batch progress.
    let mapping = batchRowMapRef.current;
    if (!mapping) {
      // After a reload, show a batch still running for the selected vault.
      const selected = currentVaults[selectedVaultRef.current];
      const running = selected ? data.batches.find((b) => b.status === 'running' && b.vaultKey === vaultKeyOf(selected)) : undefined;
      if (running) {
        mapping = { batchId: running.id, vaultKey: running.vaultKey, queueIndexes: running.rows.map((_, i) => i) };
        batchRowMapRef.current = mapping;
        setCsvQueue(running.rows.map((row) => ({
          id: `server-${running.id}-${row.rowIndex}`,
          address: row.walletAddress,
          privateKey: '',
          amount: row.amount,
          status: BATCH_ROW_STATUS[row.status],
        })));
      }
    }
    if (mapping) {
      const batch = data.batches.find((b) => b.id === mapping!.batchId);
      if (batch) {
        const queueIndexes = mapping.queueIndexes;
        setCsvQueue((queue) => queue.map((item, queueIndex) => {
          const rowIndex = queueIndexes.indexOf(queueIndex);
          const row = rowIndex >= 0 ? batch.rows[rowIndex] : undefined;
          if (!row) return item;
          const next: CsvWalletQueueItem = { ...item, status: BATCH_ROW_STATUS[row.status] };
          if (row.txHash) next.txHash = row.txHash; else delete next.txHash;
          if (row.error) next.error = row.error; else delete next.error;
          return next;
        }));
        const active = batch.rows.find((row) => row.status === 'sending') ?? (batch.status === 'running' ? batch.rows.find((row) => row.status === 'pending') : undefined);
        setBatchRunning(batch.status === 'running');
        setBatchActiveIndex(active ? queueIndexes[active.rowIndex] ?? null : null);
      }
    }
  }

  async function loadPublicConfig() {
    try {
      const response = await apiRequest('/api/config/public');
      if (!response.ok) throw new Error('Configuration service unavailable.');
      const data = await response.json() as {
        chain?: ChainConfig;
        evmMainnet?: EvmConfig;
        bnbMainnet?: EvmConfig;
        nativeToken?: TokenConfig;
        token?: TokenConfig;
        ibcTransfer?: IbcTransferConfig;
        vaults: Array<{ name: string; address: string | null; chainType?: ChainType; evmNetwork?: 'mainnet' }>;
      };

      const nextChainConfig = data.chain ?? defaultChainConfig;
      const nextEvmMainnetConfig = data.evmMainnet ?? defaultEvmMainnetConfig;
      const nextBnbMainnetConfig = data.bnbMainnet ?? defaultBnbMainnetConfig;
      const nextTransferToken = data.token ?? defaultTokenConfig;
      const nextNativeToken = data.nativeToken ?? defaultTokenConfig;
      const nextIbcTransfer = data.ibcTransfer ?? defaultIbcTransferConfig;

      // Base vaults updated with backend configuration
      const baseVaults: Vault[] = defaultVaults.map((item, index) => ({
        ...item,
        name: data.vaults?.[index]?.name ?? item.name,
        address: data.vaults?.[index]?.address ?? item.address,
        chainType: (data.vaults?.[index]?.chainType ?? item.chainType) as ChainType,
        evmNetwork: data.vaults?.[index]?.evmNetwork ?? item.evmNetwork,
      }));

      // Load custom vaults from backend and local storage
      let customVaults: Vault[] = [];
      try {
        const customRes = await apiRequest('/api/vaults/custom');
        if (customRes.ok) {
          const customData = await customRes.json() as { vaults: Array<{ id: string; name: string; address: string; chainType: ChainType; evmNetwork?: 'mainnet'; tokenAddress?: string; tokenSymbol?: string; tokenDecimals?: number; summary?: string }> };
          customVaults = customData.vaults.map((cv, i) => {
            const resolvedAddress = cv.tokenAddress;
            const pairLabel = cv.chainType === 'bnb' ? `BNB ${i + 3}` : cv.chainType === 'erc' ? `ERC ${i + 3}` : `CUSTOM ${i + 1}`;
            const accentColor = cv.chainType === 'bnb' ? 'yellow' : cv.chainType === 'erc' ? 'green' : 'blue';
            return {
              id: cv.id,
              pair: pairLabel,
              name: cv.name,
              address: cv.address,
              chainType: cv.chainType,
              evmNetwork: cv.evmNetwork,
              accent: accentColor,
              tvl: '$0',
              apy: '—',
              type: 'Custom Vault',
              risk: 'Medium',
              summary: cv.summary || (cv.chainType === 'bnb' ? 'Custom BNB vault' : 'Custom user vault'),
              tokenSymbol: cv.tokenSymbol,
              tokenDecimals: cv.tokenDecimals,
              tokenAddress: resolvedAddress,
              selectedAssetSymbol: cv.tokenSymbol,
              customAsset: resolvedAddress ? {
                symbol: cv.tokenSymbol || 'TOKEN',
                name: cv.tokenSymbol ? `${cv.tokenSymbol} Token` : 'Custom Token',
                address: resolvedAddress,
                decimals: cv.tokenDecimals ?? (cv.chainType === 'bnb' ? 18 : 6),
                isCustom: true,
              } : undefined,
            };
          });
        }
      } catch {}

      // Fallback/merge from localStorage
      try {
        const localCustom = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        localCustom.forEach((lv) => {
          if (!customVaults.some((cv) => cv.address === lv.address || cv.id === lv.id)) {
            customVaults.push(lv);
          }
        });
      } catch {}

      // Retrieve deleted vaults blacklist from localStorage
      let deletedVaultIds: string[] = [];
      try {
        deletedVaultIds = JSON.parse(localStorage.getItem('vaultflow_deleted_vaults') || '[]') as string[];
      } catch {}

      const allVaultsRaw = [...baseVaults, ...customVaults];
      const allVaultsFiltered = allVaultsRaw.filter((v) => !v.id || !deletedVaultIds.includes(v.id));
      const allVaults = allVaultsFiltered.length > 0 ? allVaultsFiltered : baseVaults;

      chainConfigRef.current = nextChainConfig;
      evmMainnetConfigRef.current = nextEvmMainnetConfig;
      bnbMainnetConfigRef.current = nextBnbMainnetConfig;
      setBnbMainnetConfig(nextBnbMainnetConfig);
      transferTokenRef.current = nextTransferToken;
      nativeTokenRef.current = nextNativeToken;
      ibcTransferRef.current = nextIbcTransfer;
      vaultsRef.current = allVaults;

      setChainConfig(nextChainConfig);
      setEvmMainnetConfig(nextEvmMainnetConfig);
      setTransferToken(nextTransferToken);
      setNativeToken(nextNativeToken);
      setIbcTransfer(nextIbcTransfer);
      setVaults(allVaults);

      // Expand automations and sessions if more vaults loaded
      setAutomations((cur) => {
        const next = cur.length < allVaults.length ? [...cur, ...createInitialAutomations(allVaults.length - cur.length)] : cur;
        automationsRef.current = next;
        return next;
      });
      setWalletSessions((cur) => {
        const next = cur.length < allVaults.length ? [...cur, ...createInitialWalletSessions(allVaults.length - cur.length)] : cur;
        walletSessionsRef.current = next;
        return next;
      });
    } catch {}
  }

  async function loadBalance(index: number, address: string, generation = sessionGenerationRef.current[index] ?? 0) {
    const currentVault = vaultsRef.current[index];
    if (!currentVault) return;

    if (isEvmChain(currentVault.chainType)) {
      try {
        const vaultEvm = getVaultEvmConfig(currentVault, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
        const provider = createEvmProvider(vaultEvm);
        const activeAsset = getActiveVaultAsset(currentVault, vaultEvm, walletDiscoveredAssetsRef.current);

        let gasWei = 0n;
        try {
          gasWei = await provider.getBalance(address);
        } catch {}
        const nativeGasBaseUnits = gasWei.toString();

        if (activeAsset.isNative || !activeAsset.address) {
          if (generation === (sessionGenerationRef.current[index] ?? 0)) {
            patchWalletSession(index, { balanceBaseUnits: nativeGasBaseUnits, nativeGasBaseUnits });
          }
        } else {
          let tokenBaseUnits = '0';
          try {
            const tokenContract = new ethers.Contract(activeAsset.address, ERC20_ABI, provider);
            const bal = await tokenContract.balanceOf(address);
            tokenBaseUnits = bal.toString();
          } catch {
            // Best effort token query
          }
          if (generation === (sessionGenerationRef.current[index] ?? 0)) {
            patchWalletSession(index, { balanceBaseUnits: tokenBaseUnits, nativeGasBaseUnits });
          }
        }

        // In the background, auto-detect all wallet tokens using Alchemy if on Alchemy RPC
        if (vaultEvm.rpcUrl.includes('alchemy.com') && ethers.isAddress(address)) {
          void (async () => {
            try {
              const alchemyRes = await fetch(vaultEvm.rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'alchemy_getTokenBalances',
                  params: [address, 'erc20'],
                }),
              });
              if (!alchemyRes.ok) return;
              const data = await alchemyRes.json() as {
                result?: {
                  tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }>;
                };
              };
              const balances = data.result?.tokenBalances || [];
              const nonZero = balances.filter((b) => b.tokenBalance && b.tokenBalance !== '0x' && BigInt(b.tokenBalance) > 0n);
              if (nonZero.length > 0) {
                const found: VaultAsset[] = [];
                for (const tb of nonZero) {
                  try {
                    const cAddr = ethers.getAddress(tb.contractAddress);
                    const inspected = await inspectErc20Token(cAddr, vaultEvm);
                    if (inspected) found.push(inspected);
                  } catch {}
                }
                if (found.length > 0) {
                  setWalletDiscoveredAssets((prev) => {
                    const merged = [...prev];
                    for (const item of found) {
                      if (!merged.some((m) => m.address?.toLowerCase() === item.address?.toLowerCase())) {
                        merged.push(item);
                      }
                    }
                    walletDiscoveredAssetsRef.current = merged;
                    return merged;
                  });
                }
              }
            } catch {}
          })();
        }
      } catch {
        // Leave existing balance if EVM RPC is unreachable
      }
      return;
    }

    // Cosmos / ZIGChain. The spendable balance is the SELECTED asset's denom
    // (Noble USDC), while gas is tracked separately in the native denom.
    try {
      const zigAsset = currentVault ? getActiveVaultAsset(currentVault, defaultEvmMainnetConfig, walletDiscoveredAssetsRef.current) : null;
      const transferDenom = zigAsset?.denom ?? transferTokenRef.current.denom;
      const gasDenom = nativeTokenRef.current.denom;
      const [transferResponse, gasResponse] = await Promise.all([
        apiRequest(`/api/wallet/${encodeURIComponent(address)}/balance?denom=${encodeURIComponent(transferDenom)}`),
        transferDenom === gasDenom
          ? Promise.resolve(null)
          : apiRequest(`/api/wallet/${encodeURIComponent(address)}/balance?denom=${encodeURIComponent(gasDenom)}`),
      ]);
      if (!transferResponse.ok || (gasResponse && !gasResponse.ok)) return;
      const transferBalance = await transferResponse.json() as { amountBaseUnits: string };
      const gasBalance = gasResponse ? await gasResponse.json() as { amountBaseUnits: string } : transferBalance;
      if (generation === (sessionGenerationRef.current[index] ?? 0)) {
        patchWalletSession(index, { balanceBaseUnits: transferBalance.amountBaseUnits, nativeGasBaseUnits: gasBalance.amountBaseUnits });
      }
    } catch {}
  }

  async function loadHistory(index: number, address: string, generation = sessionGenerationRef.current[index] ?? 0) {
    const currentVault = vaultsRef.current[index];
    if (isEvmChain(currentVault?.chainType)) {
      // EVM history is recorded locally from transactions
      return;
    }
    try {
      const response = await apiRequest(`/api/wallet/${encodeURIComponent(address)}/transactions?limit=50`);
      if (!response.ok) return;
      const data = await response.json() as { transactions: Array<{ hash: string; vaultIndex: number; timestamp: string | null; amountBaseUnits: string; status: 'Success' | 'Failed' }> };
      const chainHistory: HistoryEntry[] = data.transactions
        .filter((transaction) => transaction.vaultIndex >= 0 && /^\d+$/.test(transaction.amountBaseUnits))
        .map((transaction) => ({
          id: `chain-${transaction.hash}-${transaction.vaultIndex}`,
          vaultIndex: transaction.vaultIndex,
          time: transaction.timestamp ? Date.parse(transaction.timestamp) : 0,
          amountBaseUnits: BigInt(transaction.amountBaseUnits),
          status: transaction.status,
          hash: transaction.hash,
          source: 'Chain',
        }));
      if (generation !== (sessionGenerationRef.current[index] ?? 0)) return;
      setHistory((current) => {
        const chainHashes = new Set(chainHistory.map((entry) => entry.hash));
        const localOnly = current.filter((entry) => !entry.hash || !chainHashes.has(entry.hash));
        return [...localOnly, ...chainHistory].sort((left, right) => right.time - left.time).slice(0, 100);
      });
    } catch {}
  }

  async function unlockManualSession(index: number) {
    const generation = (sessionGenerationRef.current[index] ?? 0) + 1;
    sessionGenerationRef.current[index] = generation;
    patchWalletSession(index, { unlocking: true, error: '' });
    setTransferStatus(null);
    try {
      const secret = secretInputRef.current?.value.trim() ?? '';
      if (!secret) throw new Error('Enter a private key or mnemonic.');
      const currentVault = vaultsRef.current[index];
      if (!currentVault) throw new Error('Vault not selected.');

      if (isEvmChain(currentVault.chainType)) {
        const vaultEvm = getVaultEvmConfig(currentVault, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
        const provider = createEvmProvider(vaultEvm);
        let wallet: ethers.Wallet;
        if (secret.includes(' ')) {
          const hd = ethers.HDNodeWallet.fromPhrase(secret);
          wallet = new ethers.Wallet(hd.privateKey, provider);
        } else {
          const cleanHex = secret.startsWith('0x') ? secret : `0x${secret}`;
          if (!/^0x[0-9a-fA-F]{64}$/.test(cleanHex)) {
            throw new Error('Use a 32-byte (64 hex characters) private key or 12/24-word mnemonic.');
          }
          wallet = new ethers.Wallet(cleanHex, provider);
        }
        const derivedAddress = wallet.address;
        const expectedAddress = walletSessionsRef.current[index]?.manualAddress.trim();
        if (expectedAddress && expectedAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
          throw new Error(`The key belongs to ${derivedAddress}, not the entered address.`);
        }
        signersRef.current[index] = { type: 'evm', wallet, provider };
        signerSecretsRef.current[index] = secret;
        patchWalletSession(index, { source: 'private', address: derivedAddress, manualAddress: derivedAddress, hasSigner: true });
        await loadBalance(index, derivedAddress, generation);
      } else {
        const signer = secret.includes(' ')
          ? await DirectSecp256k1HdWallet.fromMnemonic(secret, { prefix: 'zig' })
          : await DirectSecp256k1Wallet.fromKey(hexToBytes(secret), 'zig');
        const [account] = await signer.getAccounts();
        if (!account) throw new Error('No wallet account could be derived.');
        const expectedAddress = walletSessionsRef.current[index]?.manualAddress.trim();
        if (expectedAddress && expectedAddress !== account.address) {
          throw new Error(`The key belongs to ${account.address}, not the entered address.`);
        }
        signersRef.current[index] = { type: 'cosmos', signer };
        signerSecretsRef.current[index] = secret;
        patchWalletSession(index, { source: 'private', address: account.address, manualAddress: account.address, hasSigner: true });
        await loadBalance(index, account.address, generation);
        void loadHistory(index, account.address, generation);
      }

      if (secretInputRef.current) secretInputRef.current.value = '';
    } catch (error) {
      signersRef.current[index] = null;
      delete signerSecretsRef.current[index];
      patchWalletSession(index, { hasSigner: false, error: error instanceof Error ? error.message : 'Could not unlock this wallet.' });
    } finally {
      patchWalletSession(index, { unlocking: false });
    }
  }

  /** Pause / resume / stop a server automation and reflect the result. */
  async function automationAction(index: number, action: 'pause' | 'resume' | 'stop'): Promise<boolean> {
    const serverId = automationsRef.current[index]?.serverId;
    if (!serverId) {
      // Nothing was started on the server; just reset the local panel.
      if (action !== 'resume') patchAutomation(index, { status: action === 'pause' ? 'paused' : 'stopped', nextAt: null });
      return true;
    }
    try {
      const response = await apiRequest(`/api/automations/${encodeURIComponent(serverId)}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = await response.json() as { automation: ServerAutomation };
      const server = data.automation;
      patchAutomation(index, server.status === 'stopped'
        ? { status: 'stopped', nextAt: null, serverId: null, inFlight: false }
        : { status: server.status, nextAt: server.nextRunAt, lastError: server.lastError, inFlight: server.inFlightSince !== null });
      return true;
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : `Could not ${action} the automation.` });
      return false;
    }
  }

  function stopAutomation(index: number) {
    return automationAction(index, 'stop');
  }

  function pauseAutomation(index: number) {
    return automationAction(index, 'pause');
  }

  function stopAll() {
    automationsRef.current.forEach((item, index) => {
      if (item.status !== 'stopped') void automationAction(index, 'stop');
    });
  }

  function pauseAll() {
    automationsRef.current.forEach((item, index) => {
      if (item.status === 'running') void automationAction(index, 'pause');
    });
  }

  function clearWalletSession(index: number) {
    // Clears the key from this browser only. A server automation already
    // started for this vault keeps running with its own encrypted copy — stop
    // it explicitly to end it.
    sessionGenerationRef.current[index] = (sessionGenerationRef.current[index] ?? 0) + 1;
    signersRef.current[index] = null;
    delete signerSecretsRef.current[index];
    patchWalletSession(index, { source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false });
    setHistory((current) => current.filter((entry) => entry.vaultIndex !== index));
    setSendingVaults((current) => current.filter((item) => item !== index));
    if (selectedVault === index) setTransferStatus(null);
    if (secretInputRef.current) secretInputRef.current.value = '';
  }

  async function disconnectWallet(index: number) {
    clearWalletSession(index);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginSubmitting(true);
    setLoginError('');
    try {
      const response = await apiRequest('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      if (!response.ok) throw new Error('Email or password is incorrect.');
      const data = await response.json() as { user: AuthUser };
      setAuthUser(data.user);
      setLoginPassword('');
      await loadPublicConfig();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign in failed.');
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function handleLogout() {
    await Promise.all(vaults.map((_, index) => disconnectWallet(index)));
    try { await apiRequest('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    const resetAutomations = createInitialAutomations(defaultVaults.length);
    automationsRef.current = resetAutomations;
    setAutomations(resetAutomations);
    setAuthUser(null);
    setVaults(defaultVaults);
    vaultsRef.current = defaultVaults;
    chainConfigRef.current = defaultChainConfig;
    transferTokenRef.current = defaultTokenConfig;
    nativeTokenRef.current = defaultTokenConfig;
    ibcTransferRef.current = defaultIbcTransferConfig;
    setChainConfig(defaultChainConfig);
    setTransferToken(defaultTokenConfig);
    setNativeToken(defaultTokenConfig);
    setIbcTransfer(defaultIbcTransferConfig);
    setAdminOpen(false);
    setCompanyUsers([]);
    setAddVaultOpen(false);
    setSidebarOpen(false);
    setSidebarFilter('all');
    setHistory([]);
    setSelectedVault(0);
    setLoginEmail('');
    setLoginPassword('');
  }

  async function openUserManagement() {
    setAdminMessage('');
    try {
      const response = await apiRequest('/api/admin/users');
      if (!response.ok) throw new Error('Could not load company user directory.');
      const data = await response.json() as { users: AuthUser[] };
      setCompanyUsers(data.users);
      setAdminOpen(true);
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Could not load users.');
      setAdminOpen(true);
    }
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingUser(true);
    setAdminMessage('');
    try {
      const response = await apiRequest('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newUserEmail, password: newUserPassword }),
      });
      const data = await response.json() as { user?: AuthUser; message?: string; code?: string };
      if (!response.ok) throw new Error(data.message || 'User creation failed.');
      if (data.user) setCompanyUsers((current) => [...current, data.user!]);
      setNewUserEmail('');
      setNewUserPassword('');
      setAdminMessage('Team account created successfully.');
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'User creation failed.');
    } finally {
      setCreatingUser(false);
    }
  }

  async function copyTransactionHash(hash: string) {
    await navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    window.setTimeout(() => setCopiedHash((current) => current === hash ? '' : current), 1800);
  }

  function getAmountRange(index: number) {
    const currentVault = vaultsRef.current[index] ?? vaults[index];
    if (!currentVault) throw new Error('Selected vault is unavailable.');
    const vaultEvm = getVaultEvmConfig(currentVault, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
    const activeAsset = getActiveVaultAsset(currentVault, vaultEvm, walletDiscoveredAssetsRef.current);
    const decimals = activeAsset?.decimals ?? (currentVault.tokenDecimals ?? (isEvmChain(currentVault.chainType) ? 18 : transferTokenRef.current.decimals));
    const settings = automationsRef.current[index] ?? automations[index];
    if (!settings) throw new Error('Automation settings not initialized for this vault.');
    const minimum = parseTokenAmount(settings.minimum, decimals);
    const maximum = settings.mode === 'once' ? minimum : settings.maximum.trim() ? parseTokenAmount(settings.maximum, decimals) : minimum;
    if (maximum < minimum) throw new Error('Maximum amount must be greater than or equal to the minimum.');
    const intervalSec = (settings.interval && settings.interval >= 1) ? settings.interval : 30;
    if (settings.mode === 'automation' && intervalSec < 1) throw new Error('Frequency must be at least 1 second.');
    return { minimum, maximum };
  }

  function canSend(index: number) {
    const target = vaultsRef.current[index] ?? vaults[index];
    const session = walletSessionsRef.current[index] ?? walletSessions[index];
    if (!target) return false;
    const vaultEvm = getVaultEvmConfig(target, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
    const activeAsset = getActiveVaultAsset(target, vaultEvm, walletDiscoveredAssetsRef.current);
    const decimals = activeAsset.decimals;
    const settings = automationsRef.current[index] ?? automations[index];
    return Boolean(session?.hasSigner && target?.address && target.address !== 'Not configured' && settings && hasValidRange(settings, decimals));
  }

  function canAutomate(index: number) {
    const session = walletSessionsRef.current[index] ?? walletSessions[index];
    return session?.source === 'private' && canSend(index);
  }

  function buildOrbiterMemo(settings: IbcTransferConfig['orbiter']) {
    if (!settings.enabled) return '';
    if (!settings.mintRecipient || !settings.destinationCaller) throw new Error('Orbiter CCTP memo is missing mint recipient or destination caller.');
    const preActions = settings.feeRecipient && settings.feeAmount ? [{
      id: 'ACTION_FEE',
      attributes: {
        '@type': '/noble.orbiter.controller.action.v2.FeeAttributes',
        fees_info: [{ recipient: settings.feeRecipient, amount: { value: settings.feeAmount } }],
      },
    }] : [];
    return JSON.stringify({
      orbiter: {
        pre_actions: preActions,
        forwarding: {
          protocol_id: 'PROTOCOL_CCTP',
          attributes: {
            '@type': '/noble.orbiter.controller.forwarding.v1.CCTPAttributes',
            destination_domain: settings.destinationDomain,
            mint_recipient: settings.mintRecipient,
            destination_caller: settings.destinationCaller,
          },
          passthrough_payload: settings.passthroughPayload,
        },
      },
    });
  }

  /**
   * The bank denom to move for a ZIGChain vault. This is the SELECTED asset's
   * denom (e.g. the Noble USDC ibc/ hash), never the chain's gas denom — those
   * differ, and sending uzig for a USDC selection would move the wrong asset.
   */
  function cosmosTransferDenom(targetVault?: Vault | null): string {
    const asset = targetVault ? getActiveVaultAsset(targetVault, defaultEvmMainnetConfig, walletDiscoveredAssetsRef.current) : null;
    const denom = asset?.denom;
    if (!denom) throw new Error(`No bank denom is configured for ${asset?.symbol ?? 'the selected asset'} on ZIGChain.`);
    return denom;
  }

  function buildIbcTransferMessage(sender: string, receiver: string, amount: bigint, denom: string): EncodeObject {
    const settings = ibcTransferRef.current;
    if (!settings.sourcePort || !settings.sourceChannel) throw new Error('IBC source port and channel must be configured.');
    return {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: {
        sourcePort: settings.sourcePort,
        sourceChannel: settings.sourceChannel,
        token: { denom, amount: amount.toString() },
        sender,
        receiver,
        timeoutHeight: { revisionNumber: BIGINT_ZERO, revisionHeight: BIGINT_ZERO },
        timeoutTimestamp: BigInt(unixNow() + (settings.timeoutSeconds * 1000)) * MILLISECONDS_TO_NANOSECONDS,
        memo: buildOrbiterMemo(settings.orbiter),
      },
    };
  }

  async function executeTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation'): Promise<boolean> {
    const generation = sessionGenerationRef.current[index] ?? 0;
    const universalSigner = signersRef.current[index];
    const target = vaultsRef.current[index];
    if (!universalSigner || !target?.address || target.address === 'Not configured') {
      setTransferStatus({ kind: 'error', message: 'Unlock the private key signer and configure the vault address first.' });
      return false;
    }

    const startedAt = unixNow();
    const id = `${startedAt}-${index}-${crypto.randomUUID()}`;
    const entry: HistoryEntry = { id, vaultIndex: index, time: startedAt, amountBaseUnits: amount, status: 'Pending', source };
    setHistory((current) => [entry, ...current].slice(0, 100));
    setSendingVaults((current) => [...new Set([...current, index])]);

    try {
      if (isEvmChain(target.chainType)) {
        if (universalSigner.type !== 'evm') throw new Error('Signer is not an EVM wallet.');

        const vaultEvm = getVaultEvmConfig(target, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
        const activeAsset = getActiveVaultAsset(target, vaultEvm, walletDiscoveredAssetsRef.current);
        const symbol = activeAsset.symbol;
        const decimals = activeAsset.decimals;
        const gasSymbol = target.chainType === 'bnb' ? (vaultEvm.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH';

        // Pre-flight gas check on EVM (must have native ETH / BNB to pay network gas fees)
        let gasBalanceWei: bigint | null = null;
        try {
          gasBalanceWei = await universalSigner.provider.getBalance(universalSigner.wallet.address);
        } catch {}

        if (gasBalanceWei !== null && gasBalanceWei === 0n) {
          throw new Error(`Insufficient funds for gas: Your wallet (${universalSigner.wallet.address.slice(0, 6)}…${universalSigner.wallet.address.slice(-4)}) has 0 ${gasSymbol}. ${target.chainType === 'bnb' ? 'BNB Chain' : 'EVM'} transactions require ${gasSymbol} to pay network gas fees.`);
        }

        let txHash = '';

        // Check if vault target is a contract or EOA
        let isContract = false;
        try {
          const code = await universalSigner.provider.getCode(target.address);
          isContract = Boolean(code && code !== '0x' && code !== '0x0');
        } catch {}

        if (activeAsset.isNative || !activeAsset.address) {
          // Stablecoins only: refuse rather than silently move native ETH/BNB.
          throw new Error(`No token contract is configured for ${symbol} on ${target.name}. Native ${gasSymbol} transfers are disabled; select USDT or USDC.`);
        } else {
          // ERC-20 / BEP-20 token deposit (0xb6b55f25) or transfer (USDT, USDC, mUSDC, etc.)
          const tokenContract = new ethers.Contract(activeAsset.address, ERC20_ABI, universalSigner.wallet);

          let tokenBal: bigint | null = null;
          try {
            tokenBal = await tokenContract.balanceOf(universalSigner.wallet.address);
          } catch {}

          if (tokenBal !== null) {
            if (tokenBal === 0n) {
              throw new Error(`Insufficient balance: Your wallet (${universalSigner.wallet.address.slice(0, 6)}…${universalSigner.wallet.address.slice(-4)}) has 0 ${symbol}. Please fund your wallet with ${symbol}.`);
            }
            if (tokenBal < amount) {
              throw new Error(`Insufficient balance: Current balance (${formatBaseUnits(tokenBal, decimals)} ${symbol}) is less than transfer amount (${formatBaseUnits(amount, decimals)} ${symbol}).`);
            }
          }

          if (isContract) {
            // Check allowance first and approve if insufficient
            let allowance: bigint = 0n;
            try {
              allowance = await tokenContract.allowance(universalSigner.wallet.address, target.address);
            } catch {}

            if (allowance < amount) {
              setTransferStatus({ kind: 'success', message: `Approving ${symbol} spending for vault contract…` });
              const approveTx = await tokenContract.approve(target.address, ethers.MaxUint256);
              const approveReceipt = await approveTx.wait(1);
              if (!approveReceipt || approveReceipt.status === 0) {
                throw new Error(`Token approval for ${symbol} failed.`);
              }
            }

            // Call deposit(0xb6b55f25)
            const vaultContract = new ethers.Contract(target.address, VAULT_DEPOSIT_ABI, universalSigner.wallet);
            let depositSent = false;
            try {
              const tx = await vaultContract['deposit(uint256)'](amount);
              const receipt = await tx.wait(1);
              if (!receipt || receipt.status === 0) throw new Error(`Vault deposit(uint256) was reverted by the network.`);
              txHash = tx.hash;
              depositSent = true;
            } catch (contractErr: any) {
              console.warn('deposit(uint256) reverted, falling back to token transfer:', contractErr);
            }

            if (!depositSent) {
              const tx = await tokenContract.transfer(target.address, amount);
              const receipt = await tx.wait(1);
              if (!receipt || receipt.status === 0) throw new Error(`${symbol} transfer was reverted by the network.`);
              txHash = tx.hash;
            }
          } else {
            const tx = await tokenContract.transfer(target.address, amount);
            const receipt = await tx.wait(1);
            if (!receipt || receipt.status === 0) throw new Error(`${symbol} transfer was reverted by the network.`);
            txHash = tx.hash;
          }
        }

        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return true;

        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Success', hash: txHash } : item));
        setTransferStatus({
          kind: 'success',
          message: `${formatBaseUnits(amount, decimals)} ${symbol} transferred to ${target.name}.`,
          hash: txHash,
        });
        try { await loadBalance(index, universalSigner.wallet.address, generation); } catch {}
        return true;
      } else {
        if (universalSigner.type !== 'cosmos') throw new Error('Signer is not a Cosmos signer.');
        const signer = universalSigner.signer;
        const [account] = await signer.getAccounts();
        if (!account) throw new Error('Signer account is unavailable.');
        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return false;

        const zigAsset = getActiveVaultAsset(target, defaultEvmMainnetConfig, walletDiscoveredAssetsRef.current);
        const zigDenom = cosmosTransferDenom(target);
        const zigSymbol = zigAsset.symbol;
        const zigDecimals = zigAsset.decimals;

        // Pre-flight balance check on Cosmos if known
        const currentBalanceStr = walletSessionsRef.current[index]?.balanceBaseUnits;
        if (currentBalanceStr) {
          const currentBal = BigInt(currentBalanceStr);
          if (currentBal === 0n) {
            throw new Error(`Insufficient balance: Your wallet (${account.address.slice(0, 8)}…${account.address.slice(-4)}) has 0 ${zigSymbol}. Please fund your wallet before transferring.`);
          }
          if (currentBal < amount) {
            throw new Error(`Insufficient balance: Current balance (${formatBaseUnits(currentBal, zigDecimals)} ${zigSymbol}) is less than transfer amount (${formatBaseUnits(amount, zigDecimals)} ${zigSymbol}).`);
          }
        }

        // Gas is always paid in the chain's native denom, independent of the
        // asset being transferred.
        const client = await SigningStargateClient.connectWithSigner(
          chainConfigRef.current.rpcUrl,
          signer,
          { gasPrice: GasPrice.fromString(`0.025${nativeTokenRef.current.denom}`) }
        );

        let txHash = '';
        // If target is a native ZIGChain address (starts with zig1), use a standard bank send
        if (target.address.startsWith('zig1')) {
          const sendResult = await client.sendTokens(
            account.address,
            target.address,
            [coin(amount.toString(), zigDenom)],
            GAS_MULTIPLIER
          );
          if (sendResult.code !== 0) throw new Error(sendResult.rawLog || `Transaction failed with code ${sendResult.code}.`);
          txHash = sendResult.transactionHash;
        } else {
          const ibcResult = await client.signAndBroadcast(
            account.address,
            [buildIbcTransferMessage(account.address, target.address, amount, zigDenom)],
            GAS_MULTIPLIER
          );
          if (ibcResult.code !== 0) throw new Error(ibcResult.rawLog || `Transaction failed with code ${ibcResult.code}.`);
          txHash = ibcResult.transactionHash;
        }

        if (generation !== (sessionGenerationRef.current[index] ?? 0)) return true;
        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Success', hash: txHash } : item));
        setTransferStatus({
          kind: 'success',
          message: `${formatBaseUnits(amount, zigDecimals)} ${zigSymbol} transferred to ${target.name}.`,
          hash: txHash,
        });
        try { await loadBalance(index, account.address, generation); } catch {}
        return true;
      }
    } catch (error) {
      const vaultEvm = target ? getVaultEvmConfig(target, evmMainnetConfigRef.current, bnbMainnetConfigRef.current) : undefined;
      const activeAsset = target && vaultEvm ? getActiveVaultAsset(target, vaultEvm, walletDiscoveredAssetsRef.current) : null;
      const symbol = activeAsset?.symbol ?? (target?.tokenSymbol ?? (target?.chainType === 'bnb' ? 'BNB' : target?.chainType === 'erc' ? 'ETH' : transferTokenRef.current.symbol));
      const message = formatBlockchainError(error, target?.chainType ?? 'zigchain', symbol);
      if (generation === (sessionGenerationRef.current[index] ?? 0)) {
        setHistory((current) => current.map((item) => item.id === id ? { ...item, status: 'Failed', error: message } : item));
        setTransferStatus({ kind: 'error', message });
      }
      return false;
    } finally {
      setSendingVaults((current) => current.filter((item) => item !== index));
    }
  }

  function enqueueTransfer(index: number, amount: bigint, source: 'Manual' | 'Automation') {
    const queue = transferQueueRef.current[index] ?? Promise.resolve(true);
    const nextExecution = queue.then(() => executeTransfer(index, amount, source), () => executeTransfer(index, amount, source));
    transferQueueRef.current[index] = nextExecution;
    return nextExecution;
  }

  /**
   * The asset a server job would send, checked against the server's allowlist:
   * standard USDT/USDC only. Returns the request fields that identify it.
   */
  function automationAssetFields(target: Vault) {
    const vaultEvm = getVaultEvmConfig(target, evmMainnetConfigRef.current, bnbMainnetConfigRef.current);
    const asset = getActiveVaultAsset(target, vaultEvm, walletDiscoveredAssetsRef.current);
    if (asset.symbol !== 'USDT' && asset.symbol !== 'USDC') {
      throw new Error(`Automation sends USDT or USDC only; ${asset.symbol} is selected for ${target.name}.`);
    }
    return {
      assetSymbol: asset.symbol,
      ...(asset.address ? { assetAddress: asset.address } : {}),
      ...(asset.denom ? { assetDenom: asset.denom } : {}),
    };
  }

  function announceServerJob(workerOnline: boolean, started: string) {
    setTransferStatus(workerOnline
      ? { kind: 'success', message: `${started} It runs on the server and keeps going if you close this tab.` }
      : { kind: 'error', message: `${started} But the automation worker is offline, so nothing will send until it runs (npm run dev:worker).` });
  }

  async function startAutomation(index: number) {
    try {
      const current = automationsRef.current[index] ?? automations[index];
      if (current?.mode !== 'automation') throw new Error('Select Automation mode first.');
      const target = vaultsRef.current[index] ?? vaults[index];
      if (!target?.address || target.address === 'Not configured') throw new Error('This vault address is not configured.');

      // A paused server automation still holds its encrypted key: just resume.
      if (current.status === 'paused' && current.serverId) {
        if (await automationAction(index, 'resume')) announceServerJob(Boolean(serverState?.workerOnline), `Automation resumed for ${target.name}.`);
        return;
      }

      getAmountRange(index);
      const secret = signerSecretsRef.current[index];
      if (!secret) throw new Error('Unlock the private-key session first.');
      const intervalSeconds = (current.interval && current.interval >= 1) ? current.interval : 30;

      const response = await apiRequest('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultKey: vaultKeyOf(target),
          vaultName: target.name,
          chainType: target.chainType,
          vaultAddress: target.address,
          ...automationAssetFields(target),
          minAmount: current.minimum.trim(),
          maxAmount: current.maximum.trim() || current.minimum.trim(),
          intervalSeconds,
          secret,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = await response.json() as { automation: ServerAutomation; workerOnline: boolean };
      patchAutomation(index, { status: 'running', serverId: data.automation.id, nextAt: data.automation.nextRunAt, lastError: null, inFlight: false });
      announceServerJob(data.workerOnline, `Automation started for ${target.name}.`);
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Could not start the automation.' });
    }
  }

  function canStartOrResume(index: number) {
    const current = automationsRef.current[index] ?? automations[index];
    if (current?.status === 'running') return false;
    // Resuming uses the key already stored on the server; starting needs one.
    return current?.status === 'paused' && current.serverId ? true : canAutomate(index);
  }

  function startAll() {
    automationsRef.current.forEach((item, index) => {
      if (item.mode === 'automation' && canStartOrResume(index)) void startAutomation(index);
    });
  }

  function sendManualTransfer() {
    setTransferStatus(null);
    try {
      const { minimum } = getAmountRange(selectedVault);
      void enqueueTransfer(selectedVault, minimum, 'Manual');
    } catch (error) {
      const target = vaultsRef.current[selectedVault];
      const symbol = target?.tokenSymbol ?? (target?.chainType === 'bnb' ? 'BNB' : target?.chainType === 'erc' ? 'ETH' : transferTokenRef.current.symbol);
      setTransferStatus({ kind: 'error', message: formatBlockchainError(error, target?.chainType ?? 'zigchain', symbol) });
    }
  }

  async function loadDefaultChainCsv(targetVault: Vault) {
    setCsvLoading(true);
    setCsvError(null);
    try {
      const chainParam = targetVault.chainType === 'zigchain' ? 'zigchain' : targetVault.chainType === 'bnb' ? 'bnb' : 'erc';
      const res = await fetch(`/api/csv/template?chain=${chainParam}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load CSV template`);
      const text = await res.text();
      const items = parseWalletCsv(text);
      if (items.length === 0) throw new Error('No valid wallet rows found in CSV template');
      batchRowMapRef.current = null;
      setCsvQueue(items);
    } catch (err: any) {
      setCsvError(err?.message || 'Failed to load default CSV template');
    } finally {
      setCsvLoading(false);
    }
  }

  function handleCsvFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvLoading(true);
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = (e.target?.result as string) || '';
        const items = parseWalletCsv(text);
        if (items.length === 0) throw new Error('No valid wallet rows found in uploaded CSV file');
        batchRowMapRef.current = null;
        setCsvQueue(items);
      } catch (err: any) {
        setCsvError(err?.message || 'Failed to parse uploaded CSV');
      } finally {
        setCsvLoading(false);
      }
    };
    reader.onerror = () => {
      setCsvError('Failed to read uploaded file');
      setCsvLoading(false);
    };
    reader.readAsText(file);
    if (event.target) event.target.value = '';
  }

  async function startBatchAutomation() {
    if (batchRunning) return;
    const target = vaultsRef.current[selectedVault];
    if (!target?.address || target.address === 'Not configured') {
      setTransferStatus({ kind: 'error', message: 'Vault address is not configured.' });
      return;
    }
    if (csvQueue.length === 0) {
      setTransferStatus({ kind: 'error', message: 'CSV queue is empty. Load template or upload a CSV file first.' });
      return;
    }

    // Submit every row that can be sent. Skipped: rows already successful (a
    // re-run retries only the rest), rows whose CSV line was unreadable, and
    // rows shown from a server batch after a reload (their keys are not kept
    // in the browser). Any other problem fails only that row, on the server.
    const fromServer = (item: CsvWalletQueueItem) => item.id.startsWith('server-');
    const queueIndexes = csvQueue.flatMap((item, index) => (
      item.status === 'Success' || item.parseError || fromServer(item) ? [] : [index]
    ));
    if (queueIndexes.length === 0) {
      const message = csvQueue.every((item) => item.status === 'Success')
        ? 'Every row in this CSV has already succeeded.'
        : csvQueue.some(fromServer)
        ? 'Keys are not kept after a page reload. Upload the CSV file again to re-run it.'
        : 'No row in this CSV can be sent. See the reason on each row.';
      setTransferStatus({ kind: 'error', message });
      return;
    }

    const currentAuto = automationsRef.current[selectedVault];
    const delaySeconds = (currentAuto?.interval && currentAuto.interval >= 1) ? currentAuto.interval : 2;
    setTransferStatus(null);

    try {
      const response = await apiRequest('/api/automation-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultKey: vaultKeyOf(target),
          vaultName: target.name,
          chainType: target.chainType,
          vaultAddress: target.address,
          ...automationAssetFields(target),
          delaySeconds,
          rows: queueIndexes.map((index) => {
            const item = csvQueue[index]!;
            return { walletAddress: item.address, secret: item.privateKey, amount: item.amount };
          }),
        }),
      });

      // Only whole-request problems (session, vault, a batch already running)
      // fail here; individual bad rows come back as Failed rows below.
      if (!response.ok) throw new Error(await readApiError(response));

      const data = await response.json() as { batch: ServerBatch; queued: number; skipped: number; workerOnline: boolean };
      batchRowMapRef.current = { batchId: data.batch.id, vaultKey: data.batch.vaultKey, queueIndexes };
      setCsvQueue((queue) => queue.map((item, index) => {
        const row = data.batch.rows[queueIndexes.indexOf(index)];
        if (!row) return item;
        const { txHash: _txHash, error: _error, ...rest } = item;
        return { ...rest, status: BATCH_ROW_STATUS[row.status], ...(row.error ? { error: row.error } : {}) };
      }));
      const running = data.batch.status === 'running';
      setBatchRunning(running);
      const firstPending = data.batch.rows.findIndex((row) => row.status === 'pending');
      setBatchActiveIndex(firstPending >= 0 ? queueIndexes[firstPending] ?? null : null);

      const skippedHere = csvQueue.filter((item) => item.parseError).length;
      const skipped = data.skipped + skippedHere;
      const total = data.queued + skipped;
      if (data.queued === 0) {
        setTransferStatus({ kind: 'error', message: `None of the ${total} rows can be sent, so nothing will be sent. See the reason on each row.` });
        return;
      }
      const skippedNote = skipped ? ` ${skipped} row${skipped === 1 ? ' was' : 's were'} skipped — see the reason on each row.` : '';
      announceServerJob(data.workerOnline, `${data.queued} of ${total} wallet${total === 1 ? '' : 's'} queued for ${target.name}.${skippedNote}`);
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Could not start the batch.' });
    }
  }

  async function stopBatchAutomation() {
    const mapping = batchRowMapRef.current;
    if (!mapping) return;
    try {
      const response = await apiRequest(`/api/automation-batches/${encodeURIComponent(mapping.batchId)}/cancel`, { method: 'POST' });
      if (!response.ok && response.status !== 409) throw new Error(await readApiError(response));
      // A row already broadcasting finishes; remaining rows are cancelled and
      // every stored key for the batch is wiped. The next poll shows the result.
      setBatchRunning(false);
      setBatchActiveIndex(null);
    } catch (error) {
      setTransferStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Could not stop the batch.' });
    }
  }

  function updateSelectedAutomation(patch: Partial<Automation>) { patchAutomation(selectedVault, patch); }

  async function selectDeliveryMode(mode: DeliveryMode) {
    // Leaving Automation mode stops the server schedule (and wipes its key)
    // first, so the next state poll cannot switch the panel back.
    if (automation.status !== 'stopped' && !(await stopAutomation(selectedVault))) return;
    patchAutomation(selectedVault, { mode, status: 'stopped', nextAt: null });
    setTransferStatus(null);
  }

  function setCustomFrequency(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      updateSelectedAutomation({ customInterval: '', interval: 30 });
      return;
    }
    const seconds = Number(trimmed);
    if (!Number.isNaN(seconds) && seconds >= 1) {
      updateSelectedAutomation({
        customInterval: value,
        interval: Math.max(1, Math.floor(seconds)),
      });
    } else {
      updateSelectedAutomation({ customInterval: value });
    }
  }

  async function handleAddVault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddVaultError('');
    const name = newVaultName.trim();
    const address = newVaultAddress.trim();
    if (!name) return setAddVaultError('Vault name is required.');
    if (!address) return setAddVaultError('Vault address is required.');

    if (newVaultChain === 'zigchain') {
      if (!/^zig1[0-9a-z]{38,62}$/.test(address)) {
        return setAddVaultError('Enter a valid ZIGChain Bech32 address (starts with zig1...).');
      }
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return setAddVaultError(`Enter a valid ${newVaultChain === 'bnb' ? 'BNB Chain' : 'ERC / EVM'} hexadecimal address (0x followed by 40 hex characters).`);
      }
    }

    setSavingVault(true);
    try {
      // With nothing detected, default to the stablecoin the vault will actually
      // send (USDT on EVM, USDC on ZIGChain) — never the native gas token.
      const defaultAsset = newVaultChain === 'bnb' ? BSC_MAINNET_USDT : newVaultChain === 'erc' ? MAINNET_USDT : ZIGCHAIN_USDC;
      const symbol = newVaultSymbol.trim() || detectedAddVaultAsset?.symbol || inspectedTokenInfo?.symbol || defaultAsset.symbol;
      const decimals = newVaultDecimals.trim() ? Number(newVaultDecimals) : (detectedAddVaultAsset?.decimals ?? inspectedTokenInfo?.decimals ?? defaultAsset.decimals);
      const summary = newVaultSummary.trim() || `${newVaultChain === 'bnb' ? 'BNB Chain' : newVaultChain === 'erc' ? 'ERC / EVM' : 'ZIGChain'} custom automated vault strategy`;
      const tokenAddressToSave = (isEvmChain(newVaultChain)
        ? (newVaultTokenAddress.trim() || inspectedTokenInfo?.address || detectedAddVaultAsset?.address)
        : undefined);

      let createdId = `custom-${unixNow()}`;
      // Save to API (best effort)
      try {
        const createRes = await apiRequest('/api/vaults/custom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            address,
            chainType: newVaultChain,
            evmNetwork: isEvmChain(newVaultChain) ? 'mainnet' : undefined,
            tokenSymbol: symbol,
            tokenDecimals: decimals,
            tokenAddress: tokenAddressToSave,
            summary,
          }),
        });
        if (createRes.ok) {
          const createData = await createRes.json() as { vault?: { id: string } };
          if (createData.vault?.id) createdId = createData.vault.id;
        }
      } catch {}

      const newIndex = vaults.length;
      const bnbCount = vaults.filter((v) => v.chainType === 'bnb').length + 1;
      const ercCount = vaults.filter((v) => v.chainType === 'erc').length + 1;
      const newPair = newVaultChain === 'bnb' ? `BNB ${bnbCount}` : newVaultChain === 'erc' ? `ERC ${ercCount}` : `PAIR ${newIndex + 1}`;
      const newAccent = newVaultChain === 'bnb' ? 'yellow' : newVaultChain === 'erc' ? 'green' : 'blue';
      const newVault: Vault = {
        id: createdId,
        pair: newPair,
        name,
        address,
        chainType: newVaultChain,
        evmNetwork: isEvmChain(newVaultChain) ? 'mainnet' : undefined,
        accent: newAccent,
        tvl: '$0',
        apy: '—',
        type: 'Custom Vault',
        risk: 'Medium',
        summary,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        tokenAddress: tokenAddressToSave,
        detectedAsset: detectedAddVaultAsset || undefined,
        selectedAssetSymbol: detectedAddVaultAsset?.symbol || inspectedTokenInfo?.symbol || symbol,
        customAsset: tokenAddressToSave ? {
          symbol,
          name: inspectedTokenInfo?.name || `${symbol} Token`,
          address: tokenAddressToSave,
          decimals,
          isCustom: true,
        } : undefined,
      };

      const updatedVaults = [...vaults, newVault];
      vaultsRef.current = updatedVaults;
      setVaults(updatedVaults);

      const nextAutomations = [...automationsRef.current, { mode: 'once' as const, minimum: '', maximum: '', interval: 30, customInterval: '', status: 'stopped' as const, lastAt: null, nextAt: null }];
      automationsRef.current = nextAutomations;
      setAutomations(nextAutomations);

      const nextWalletSessions = [...walletSessionsRef.current, { mode: 'private' as const, source: null, address: '', manualAddress: '', balanceBaseUnits: '0', nativeGasBaseUnits: '0', error: '', connecting: false, unlocking: false, hasSigner: false }];
      walletSessionsRef.current = nextWalletSessions;
      setWalletSessions(nextWalletSessions);

      // Persist to localStorage
      try {
        const stored = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        stored.push(newVault);
        localStorage.setItem('vaultflow_custom_vaults', JSON.stringify(stored));
      } catch {}

      setSelectedVault(newIndex);
      setAddVaultOpen(false);
      setNewVaultName('');
      setNewVaultAddress('');
      setNewVaultSummary('');
      setNewVaultSymbol('');
      setNewVaultDecimals('');
      setNewVaultTokenAddress('');
      setInspectingToken(false);
      setInspectedTokenInfo(null);
      setDetectedAddVaultAsset(null);
    } catch (err) {
      setAddVaultError(err instanceof Error ? err.message : 'Failed to create vault.');
    } finally {
      setSavingVault(false);
    }
  }

  function handleRequestDelete(index: number, targetVault: Vault, e?: React.MouseEvent) {
    if (e) e.stopPropagation();
    if (vaults.length <= 1) {
      alert('Cannot delete the last remaining vault. At least one vault must remain configured.');
      return;
    }
    setDeleteError('');
    setVaultToDelete({ index, vault: targetVault });
    setDeleteModalOpen(true);
  }

  async function handleConfirmDelete() {
    if (!vaultToDelete) return;
    const { index: targetIndex, vault: targetVault } = vaultToDelete;
    if (vaults.length <= 1) {
      setDeleteError('Cannot delete the last remaining vault.');
      return;
    }
    setDeletingVault(true);
    setDeleteError('');

    try {
      // 1. Stop this vault's server automation (wiping its stored key) and
      //    cancel any running server batch, so nothing keeps sending for a
      //    vault that no longer exists in the console.
      if (automationsRef.current[targetIndex]?.serverId && !(await automationAction(targetIndex, 'stop'))) {
        throw new Error('Could not stop this vault\'s automation. Stop it first, then delete the vault.');
      }
      const targetKey = vaultKeyOf(targetVault);
      for (const batch of serverState?.batches ?? []) {
        if (batch.vaultKey !== targetKey || batch.status !== 'running') continue;
        const response = await apiRequest(`/api/automation-batches/${encodeURIComponent(batch.id)}/cancel`, { method: 'POST' });
        if (!response.ok && response.status !== 409) throw new Error(`Could not cancel this vault's running batch: ${await readApiError(response)}`);
      }
      if (batchRowMapRef.current?.vaultKey === targetKey) batchRowMapRef.current = null;

      // 2. Clear signer from memory
      signersRef.current[targetIndex] = null;
      delete signerSecretsRef.current[targetIndex];

      // 3. Delete from backend if it is a custom vault
      if (
        targetVault.id &&
        targetVault.id.startsWith('vault-') &&
        !['vault-1', 'vault-2', 'vault-3', 'vault-4', 'vault-5'].includes(targetVault.id)
      ) {
        try {
          await apiRequest(`/api/vaults/custom/${encodeURIComponent(targetVault.id)}`, { method: 'DELETE' });
        } catch {}
      }

      // 4. Update localStorage
      try {
        const storedCustom = JSON.parse(localStorage.getItem('vaultflow_custom_vaults') || '[]') as Vault[];
        const filteredCustom = storedCustom.filter((v) => v.id !== targetVault.id && v.address !== targetVault.address);
        localStorage.setItem('vaultflow_custom_vaults', JSON.stringify(filteredCustom));
      } catch {}

      try {
        const deletedVaultIds = JSON.parse(localStorage.getItem('vaultflow_deleted_vaults') || '[]') as string[];
        if (targetVault.id && !deletedVaultIds.includes(targetVault.id)) {
          deletedVaultIds.push(targetVault.id);
          localStorage.setItem('vaultflow_deleted_vaults', JSON.stringify(deletedVaultIds));
        }
      } catch {}

      // 5. Shift refs
      const nextSigners: Record<number, UniversalSigner | null> = {};
      const nextSecrets: Record<number, string> = {};
      const nextGens: Record<number, number> = {};
      Object.entries(signerSecretsRef.current).forEach(([k, secret]) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextSecrets[keyNum] = secret;
        else if (keyNum > targetIndex) nextSecrets[keyNum - 1] = secret;
      });
      Object.keys(signersRef.current).forEach((k) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextSigners[keyNum] = signersRef.current[keyNum];
        else if (keyNum > targetIndex) nextSigners[keyNum - 1] = signersRef.current[keyNum];
      });
      Object.keys(sessionGenerationRef.current).forEach((k) => {
        const keyNum = Number(k);
        if (keyNum < targetIndex) nextGens[keyNum] = sessionGenerationRef.current[keyNum];
        else if (keyNum > targetIndex) nextGens[keyNum - 1] = sessionGenerationRef.current[keyNum];
      });
      signerSecretsRef.current = nextSecrets;
      signersRef.current = nextSigners;
      sessionGenerationRef.current = nextGens;

      // 6. Update state arrays
      const nextVaults = vaults.filter((_, i) => i !== targetIndex);
      vaultsRef.current = nextVaults;
      setVaults(nextVaults);

      setAutomations((cur) => {
        const next = cur.filter((_, i) => i !== targetIndex);
        automationsRef.current = next;
        return next;
      });

      setWalletSessions((cur) => {
        const next = cur.filter((_, i) => i !== targetIndex);
        walletSessionsRef.current = next;
        return next;
      });

      setHistory((cur) =>
        cur
          .filter((entry) => entry.vaultIndex !== targetIndex)
          .map((entry) => ({
            ...entry,
            vaultIndex: entry.vaultIndex > targetIndex ? entry.vaultIndex - 1 : entry.vaultIndex,
          }))
      );

      // 7. Adjust selectedVault index
      if (selectedVault === targetIndex) {
        setSelectedVault(Math.max(0, Math.min(targetIndex, nextVaults.length - 1)));
      } else if (selectedVault > targetIndex) {
        setSelectedVault((cur) => cur - 1);
      }

      setDeleteModalOpen(false);
      setVaultToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete vault.');
    } finally {
      setDeletingVault(false);
    }
  }

  function handleResetDefaultVaults() {
    try {
      localStorage.removeItem('vaultflow_deleted_vaults');
    } catch {}
    void loadPublicConfig();
  }


  const statusLabel = automation.status.toUpperCase();
  const automatedVaultIndexes = automations.map((item, index) => item.mode === 'automation' ? index : -1).filter((index) => index >= 0);
  // START ALL starts or resumes every automation-mode vault that is able to.
  const allReady = automatedVaultIndexes.some((index) => canStartOrResume(index));

  const actionHint = signerMode === 'csv'
    ? (!vault.address || vault.address === 'Not configured'
      ? 'Configure this vault address first.'
      : csvQueue.length === 0
      ? 'Load default chain CSV or upload a wallet CSV file to begin batch deposits.'
      : '')
    : !walletSession.source
    ? 'Enter private key or mnemonic to unlock session.'
    : !walletSession.hasSigner
    ? 'The signer is not unlocked for this vault.'
    : !vault.address || vault.address === 'Not configured'
    ? 'Configure this vault address first.'
    : !automation.minimum.trim()
    ? 'Enter an amount to enable the transfer button.'
    : !hasValidRange(automation, currentTokenDecimals)
    ? automation.mode === 'automation'
      ? 'Check the amount range and use a frequency of at least 1 second.'
      : `Enter a valid ${currentTokenSymbol} amount.`
    : '';

  if (authLoading) return <main className="auth-shell"><div className="auth-loading"><span className="brand-glyph">V</span><p>Loading Vaultflow…</p></div></main>;

  if (!authUser) return (
    <main className="auth-shell">
      <section className="login-card">
        <div className="login-brand"><span className="brand-glyph">V</span><div><strong>Vaultflow</strong><small>Internal operations console</small></div></div>
        <div className="login-copy"><span>AUTHORIZED ACCESS</span><h1>Sign in to continue</h1><p>Use the company account provided by your administrator.</p></div>
        <form onSubmit={handleLogin}>
          <label><span>EMAIL ADDRESS</span><input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} autoComplete="username" placeholder="name@company.com" required /></label>
          <label><span>PASSWORD</span><input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" placeholder="Enter your password" required /></label>
          {loginError && <p className="login-error" role="alert">{loginError}</p>}
          <button type="submit" disabled={loginSubmitting}>{loginSubmitting ? 'SIGNING IN…' : 'SIGN IN'}</button>
        </form>
        <small className="login-footnote">Accounts are created by the company administrator.</small>
      </section>
    </main>
  );

  return (
    <main className="console-shell">
      {/* Slide Sidebar for All Vaults */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden={!sidebarOpen}
      />
      <aside
        className={`vault-sidebar ${sidebarOpen ? 'open' : ''}`}
        aria-label="Vault Strategies Directory"
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-header">
          <div className="sidebar-header-title">
            <span className="brand-glyph-sm">V</span>
            <div>
              <h3>Vault Strategies</h3>
              <small>{vaults.length} vaults configured</small>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close vaults menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <div className="sidebar-filter-tabs">
          <button
            type="button"
            className={sidebarFilter === 'all' ? 'active' : ''}
            onClick={() => setSidebarFilter('all')}
          >
            All ({vaults.length})
          </button>
          <button
            type="button"
            className={sidebarFilter === 'zigchain' ? 'active' : ''}
            onClick={() => setSidebarFilter('zigchain')}
          >
            ZIGChain ({vaults.filter((v) => v.chainType === 'zigchain').length})
          </button>
          <button
            type="button"
            className={sidebarFilter === 'erc' ? 'active' : ''}
            onClick={() => setSidebarFilter('erc')}
          >
            ERC ({vaults.filter((v) => v.chainType === 'erc').length})
          </button>
          <button
            type="button"
            className={sidebarFilter === 'bnb' ? 'active' : ''}
            onClick={() => setSidebarFilter('bnb')}
          >
            BNB ({vaults.filter((v) => v.chainType === 'bnb').length})
          </button>
        </div>

        <div className="sidebar-vaults-list">
          {vaults
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => sidebarFilter === 'all' || item.chainType === sidebarFilter)
            .map(({ item, index }) => (
              <div key={item.id || item.pair} className="sidebar-vault-item-wrap">
                <button
                  type="button"
                  className={`sidebar-vault-item ${selectedVault === index ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedVault(index);
                    setSidebarOpen(false);
                  }}
                >
                  <div className="sidebar-vault-top">
                    <span className={`chain-pill ${item.chainType}`}>
                      {item.chainType === 'bnb'
                        ? 'BSC MAINNET'
                        : item.chainType === 'erc'
                        ? 'MAINNET'
                        : 'ZIGCHAIN'}
                    </span>
                    <span className="sidebar-vault-pair">{item.pair}</span>
                    {walletSessions[index]?.source && (
                      <span className="sidebar-vault-connected" title="Signer unlocked">● UNLOCKED</span>
                    )}
                    <span className={`pair-dot ${item.accent}`} />
                  </div>
                  <div className="sidebar-vault-name">{item.name}</div>
                  <div className="sidebar-vault-meta">
                    <span className="sidebar-vault-stat"><strong>{item.apy}</strong> APY</span>
                    <span className="sidebar-vault-stat"><strong>{item.tvl}</strong> TVL</span>
                    <span className="sidebar-vault-risk">{item.risk} Risk</span>
                  </div>
                  {item.address && item.address !== 'Not configured' && (
                    <div className="sidebar-vault-address">
                      <code>{item.address.slice(0, 10)}...{item.address.slice(-6)}</code>
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  className="sidebar-vault-delete-btn"
                  title={`Delete ${item.name}`}
                  onClick={(e) => handleRequestDelete(index, item, e)}
                  aria-label={`Delete ${item.name}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                </button>
              </div>
            ))}
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-add-vault-btn"
            onClick={() => {
              setSidebarOpen(false);
              setAddVaultOpen(true);
            }}
          >
            + ADD ANOTHER VAULT
          </button>
          <button
            type="button"
            className="sidebar-reset-defaults-btn"
            onClick={handleResetDefaultVaults}
            title="Restore default pre-configured vaults if any were deleted"
          >
            RESTORE DEFAULT VAULTS
          </button>
        </div>
      </aside>

      <nav className="vault-nav" aria-label="Vault selection">
        <div className="nav-brand-section">
          <button
            type="button"
            className="sidebar-trigger-btn"
            onClick={() => setSidebarOpen(true)}
            title="Browse all vaults"
            aria-label="Toggle vaults menu"
          >
            <svg className="trigger-hamburger" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/></svg>
            <span className="trigger-label">VAULTS</span>
            <span className="trigger-badge">{vaults.length}</span>
          </button>
          <div className="nav-brand"><span className="brand-glyph">V</span><span>Vaultflow</span></div>
        </div>

        {/* Current Active Vault Switcher Pill */}
        <button
          type="button"
          className="active-vault-pill"
          onClick={() => setSidebarOpen(true)}
          title="Click to browse all vaults"
        >
          <span className={`chain-pill ${vault.chainType}`}>
            {vault.chainType === 'bnb'
              ? 'BSC MAINNET'
              : vault.chainType === 'erc'
              ? 'MAINNET'
              : 'ZIG'}
          </span>
          <span className="active-vault-name">{vault.name}</span>
          {walletSession.source && <span className="connected-mini" title="Signer unlocked">●</span>}
          <span className={`pair-dot ${vault.accent}`} />
          <svg className="active-vault-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>

        <div className="nav-actions">
          <button className="nav-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)} title="Add a new vault strategy">
            + ADD VAULT
          </button>
          <div className="account-tools">
            <span className="account-identity">
              <b>{authUser.email.slice(0, 2).toUpperCase()}</b>
              <span><strong>{authUser.email}</strong><small>{authUser.role}</small></span>
            </span>
            {authUser.role === 'ADMIN' && <button type="button" onClick={() => void openUserManagement()}>USERS</button>}
            <button className="logout-button" type="button" onClick={() => void handleLogout()}>LOGOUT</button>
          </div>
        </div>
      </nav>

      {/* Add Vault Dialog Modal */}
      {addVaultOpen && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Add new vault">
          <section className="add-vault-panel">
            <header className="add-vault-header">
              <div>
                <span>STRATEGY MANAGEMENT</span>
                <h2>Add Another Vault</h2>
                <p>Configure a new ZIGChain, ERC (Ethereum), or BNB Chain automated vault strategy.</p>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setAddVaultOpen(false)} aria-label="Close add vault">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>
            <form onSubmit={handleAddVault} className="add-vault-form">
              <div className="chain-selector-box">
                <span className="form-label">CHOOSE VAULT TYPE / NETWORK</span>
                <div className="chain-toggle-group">
                  <button
                    type="button"
                    className={`chain-select-btn ${newVaultChain === 'zigchain' ? 'active' : ''}`}
                    onClick={() => setNewVaultChain('zigchain')}
                  >
                    <strong>◈ ZIGChain (Cosmos)</strong>
                    <small>Native Cosmos SDK · zig1… addresses</small>
                  </button>
                  <button
                    type="button"
                    className={`chain-select-btn ${newVaultChain === 'erc' ? 'active' : ''}`}
                    onClick={() => setNewVaultChain('erc')}
                  >
                    <strong>⟠ Ethereum / EVM</strong>
                    <small>ERC smart contracts · 0x… addresses</small>
                  </button>
                  <button
                    type="button"
                    className={`chain-select-btn ${newVaultChain === 'bnb' ? 'active' : ''}`}
                    onClick={() => setNewVaultChain('bnb')}
                  >
                    <strong>⬡ BNB Chain (BSC)</strong>
                    <small>BEP-20 / BSC contracts · 0x… addresses</small>
                  </button>
                </div>
              </div>

              {isEvmChain(newVaultChain) && (
                <div className="chain-selector-box" style={{ marginTop: '14px' }}>
                  <span className="form-label">NETWORK</span>
                  <div className="chain-toggle-group">
                    <button type="button" className="chain-select-btn active" disabled>
                      <strong>{newVaultChain === 'bnb' ? 'BNB Smart Chain Mainnet' : 'Ethereum Mainnet'}</strong>
                      <small>{newVaultChain === 'bnb' ? 'Chain ID 56 · multi-RPC failover' : 'Chain ID 1 · multi-RPC failover'}</small>
                    </button>
                  </div>
                </div>
              )}

              <div className="form-row">
                <label>
                  <span>VAULT NAME</span>
                  <input
                    type="text"
                    value={newVaultName}
                    onChange={(e) => setNewVaultName(e.target.value)}
                    placeholder={newVaultChain === 'bnb' ? 'e.g. PancakeSwap Cake Pool' : newVaultChain === 'erc' ? 'e.g. Nawa Yield Pool' : 'e.g. High Yield Strategy'}
                    required
                  />
                </label>
                <label>
                  <span>TARGET VAULT ADDRESS</span>
                  <input
                    type="text"
                    value={newVaultAddress}
                    onChange={(e) => setNewVaultAddress(e.target.value)}
                    placeholder={isEvmChain(newVaultChain) ? '0x...' : 'zig1...'}
                    required
                    spellCheck={false}
                  />
                </label>
              </div>

              {isEvmChain(newVaultChain) && detectingAsset && (
                <div className="detecting-asset-notice">
                  <span className="spinner-dots" /> Inspecting contract for {newVaultChain === 'bnb' ? 'BEP-4626' : 'ERC-4626'} asset()…
                </div>
              )}

              {isEvmChain(newVaultChain) && detectedAddVaultAsset && (
                <div className="detected-asset-banner">
                  <div className="detected-asset-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    {newVaultChain === 'bnb' ? 'BEP-4626' : 'ERC-4626'} VAULT ASSET DETECTED
                  </div>
                  <div className="detected-asset-content">
                    <strong>{detectedAddVaultAsset.name} ({detectedAddVaultAsset.symbol})</strong>
                    <p>Underlying Token: <code>{detectedAddVaultAsset.address}</code> ({detectedAddVaultAsset.decimals} decimals)</p>
                  </div>
                </div>
              )}

              {isEvmChain(newVaultChain) && (
                <div className="form-row">
                  <label style={{ width: '100%' }}>
                    <span>TOKEN CONTRACT ADDRESS (OPTIONAL)</span>
                    <input
                      type="text"
                      value={newVaultTokenAddress}
                      onChange={(e) => setNewVaultTokenAddress(e.target.value)}
                      placeholder={newVaultChain === 'bnb' ? 'e.g. 0x55d398326f99059ff775485246999027b3197955 (USDT)' : 'e.g. 0xebe4f4ac8a99979934aad3db24edd0caf6a6e934 (mUSDC)'}
                      spellCheck={false}
                    />
                  </label>
                </div>
              )}

              {isEvmChain(newVaultChain) && inspectingToken && (
                <div className="detecting-asset-notice">
                  <span className="spinner-dots" /> Inspecting {newVaultChain === 'bnb' ? 'BEP-20' : 'ERC-20'} token contract…
                </div>
              )}

              {isEvmChain(newVaultChain) && inspectedTokenInfo && (
                <div className="detected-asset-banner">
                  <div className="detected-asset-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    {newVaultChain === 'bnb' ? 'BEP-20' : 'ERC-20'} TOKEN VERIFIED
                  </div>
                  <div className="detected-asset-content">
                    <strong>{inspectedTokenInfo.name} ({inspectedTokenInfo.symbol})</strong>
                    <p>Decimals: <code>{inspectedTokenInfo.decimals}</code> · Address: <code>{inspectedTokenInfo.address}</code></p>
                  </div>
                </div>
              )}

              <div className="form-row three-col">
                <label>
                  <span>TOKEN SYMBOL</span>
                  <input
                    type="text"
                    value={newVaultSymbol}
                    onChange={(e) => setNewVaultSymbol(e.target.value)}
                    placeholder={newVaultChain === 'bnb' ? 'USDT' : 'USDC'}
                  />
                </label>
                <label>
                  <span>DECIMALS</span>
                  <input
                    type="number"
                    value={newVaultDecimals}
                    onChange={(e) => setNewVaultDecimals(e.target.value)}
                    placeholder={newVaultChain === 'bnb' ? '18' : '6'}
                  />
                </label>
                <label>
                  <span>STRATEGY SUMMARY (OPTIONAL)</span>
                  <input
                    type="text"
                    value={newVaultSummary}
                    onChange={(e) => setNewVaultSummary(e.target.value)}
                    placeholder="e.g. Automated liquidity provision"
                  />
                </label>
              </div>

              {addVaultError && <p className="form-error" role="alert">{addVaultError}</p>}

              <button type="submit" className="create-vault-submit" disabled={savingVault}>
                {savingVault ? 'CREATING VAULT…' : 'CREATE & OPEN VAULT'}
              </button>
            </form>
          </section>
        </div>
      )}

      {adminOpen && authUser.role === 'ADMIN' && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Company user management">
          <section className="admin-panel">
            <header>
              <div>
                <span>ADMINISTRATION</span>
                <h2>Company accounts</h2>
                <p>Create login access for another team member.</p>
              </div>
              <button type="button" onClick={() => setAdminOpen(false)} aria-label="Close user management">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>
            <form onSubmit={handleCreateUser} className="admin-user-create-form">
              <label>
                <span>EMAIL</span>
                <input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="teammate@company.com" required />
              </label>
              <label>
                <span>TEMPORARY PASSWORD</span>
                <input type="password" minLength={8} value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="At least 8 characters" required />
              </label>
              <button type="submit" disabled={creatingUser}>{creatingUser ? 'CREATING…' : 'CREATE ACCOUNT'}</button>
            </form>
            {adminMessage && <p className="admin-message" role="status">{adminMessage}</p>}
            <div className="user-list">
              <div className="user-list-head"><span>ACCOUNT</span><span>ROLE</span><span>STATUS</span></div>
              {companyUsers.map((user) => (
                <div className="user-list-row" key={user.id}>
                  <span><strong>{user.email}</strong><small>Created {new Date(user.createdAt).toLocaleDateString()}</small></span>
                  <b>{user.role}</b>
                  <i>{user.active ? 'ACTIVE' : 'DISABLED'}</i>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* Delete Vault Confirmation Modal */}
      {deleteModalOpen && vaultToDelete && (
        <div className="admin-overlay" role="dialog" aria-modal="true" aria-label="Delete vault confirmation">
          <section className="delete-vault-panel">
            <header className="delete-vault-header">
              <div className="delete-warning-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              </div>
              <div style={{ flex: 1 }}>
                <span className="danger-tag">CONFIRM DELETION</span>
                <h2>Delete Vault Strategy?</h2>
                <p>Are you sure you want to permanently delete <strong>{vaultToDelete.vault.name}</strong> ({vaultToDelete.vault.pair})?</p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => { setDeleteModalOpen(false); setVaultToDelete(null); }}
                aria-label="Close delete modal"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>

            <div className="delete-vault-body">
              <div className="delete-vault-info">
                <div className="delete-info-row">
                  <span>Vault:</span>
                  <strong>{vaultToDelete.vault.name}</strong>
                </div>
                <div className="delete-info-row">
                  <span>Chain:</span>
                  <span className={`chain-pill ${vaultToDelete.vault.chainType}`}>
                    {vaultToDelete.vault.chainType === 'bnb' ? 'BNB CHAIN' : vaultToDelete.vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'}
                  </span>
                </div>
                {vaultToDelete.vault.address && vaultToDelete.vault.address !== 'Not configured' && (
                  <div className="delete-info-row">
                    <span>Target Address:</span>
                    <code>{vaultToDelete.vault.address}</code>
                  </div>
                )}
              </div>

              <div className="delete-warning-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                <span>Any active automation schedules and signing sessions for this vault will be stopped immediately.</span>
              </div>

              {deleteError && <p className="delete-vault-error" role="alert">{deleteError}</p>}

              <div className="delete-modal-actions">
                <button
                  type="button"
                  className="cancel-delete-btn"
                  onClick={() => { setDeleteModalOpen(false); setVaultToDelete(null); }}
                  disabled={deletingVault}
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="confirm-delete-btn"
                  onClick={() => void handleConfirmDelete()}
                  disabled={deletingVault}
                >
                  {deletingVault ? 'DELETING…' : 'YES, DELETE VAULT'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="console-content">
        <header className="vault-hero">
          <div className="hero-title">
            <p>
              <span className={`pulse ${vault.accent}`} /> {vault.pair} — {vault.chainType === 'bnb' ? 'BNB CHAIN' : vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'} VAULT AUTOMATION
            </p>
            <h1><span>{currentTokenSymbol}</span><b>→</b>{vault.name}</h1>
          </div>
          <div className="hero-status">
            <span
              className={`state-pill ${serverState?.workerOnline ? 'running' : 'paused'}`}
              title={serverState?.workerOnline ? 'The automation worker is running; schedules continue with this tab closed.' : 'Start the worker (npm run dev:worker). Scheduled sends are on hold until it runs.'}
            >
              <i /> {serverState ? (serverState.workerOnline ? 'WORKER ONLINE' : 'WORKER OFFLINE') : 'WORKER …'}
            </span>
            <span className={`state-pill ${automation.status}`}>{statusLabel}</span>
            <button className="hero-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)}>+ ADD VAULT</button>
            <button
              className="hero-delete-vault-btn"
              type="button"
              onClick={() => handleRequestDelete(selectedVault, vault)}
              title="Delete this vault strategy"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              DELETE VAULT
            </button>
            <button type="button" onClick={() => void disconnectWallet(selectedVault)} disabled={!walletSession.source}>CLEAR SESSION</button>
          </div>
        </header>

        <section className="global-bar">
          <div>
            <span className="global-icon">◎</span>
            <span>
              <strong>Global automation</strong>
              <small>
                {serverState && !serverState.workerOnline && anyRunning
                  ? 'Worker offline — running schedules are on hold until it starts (npm run dev:worker)'
                  : anyRunning
                  ? 'Schedules run on the server and continue with this tab closed'
                  : allReady
                  ? `${automatedVaultIndexes.length} automation schedule${automatedVaultIndexes.length === 1 ? '' : 's'} ready`
                  : 'Choose Automation on at least one vault and complete its settings'}
              </small>
            </span>
          </div>
          <div className="global-buttons">
            <button type="button" onClick={startAll} disabled={!allReady}>START ALL</button>
            <button type="button" onClick={pauseAll} disabled={!anyRunning}>PAUSE ALL</button>
            <button className="stop" type="button" onClick={stopAll} disabled={!anyActive}>STOP ALL</button>
          </div>
        </section>

        {vaultStats && vaultStats.vaults.length > 0 && (
          <section className="global-bar" style={{ flexWrap: 'wrap', gap: 12 }}>
            {vaultStats.vaults.map((entry) => {
              const hasValue = entry.tvlBaseUnits != null && entry.assetDecimals != null;
              const age = entry.updatedAt ? Math.max(0, Math.round((now - entry.updatedAt) / 60_000)) : null;
              return (
                <div key={entry.vaultKey} title={entry.error ?? undefined}>
                  <span className="global-icon">◈</span>
                  <span>
                    <strong>
                      {hasValue ? `${formatBaseUnits(entry.tvlBaseUnits!, entry.assetDecimals!)} ${entry.assetSymbol}` : entry.error ? 'Unavailable' : 'Loading…'}
                    </strong>
                    <small>
                      {entry.vaultName}{entry.isPaused ? ' · Paused' : ''}
                      {age != null ? ` · updated ${age === 0 ? 'just now' : `${age}m ago`}` : ''}
                    </small>
                  </span>
                </div>
              );
            })}
          </section>
        )}

        <section className="two-column">
          {/* Wallet Card - Single Key or CSV Batch */}
          <article className="console-card wallet-card">
            <div className="card-title">
              <span className="title-icon blue">{signerMode === 'csv' ? '☵' : '▣'}</span>
              <div>
                <h2>{signerMode === 'csv' ? 'CSV Batch Wallets' : 'Private Key Session'}</h2>
                <p>{signerMode === 'csv' ? `Multi-wallet automated vault deposit queue for ${vault.name}.` : `Unlock an interactive signing session in memory for ${vault.name}.`}</p>
              </div>
            </div>

            <div className="signer-mode-tabs">
              <button
                type="button"
                className={`signer-tab-btn ${signerMode === 'single' ? 'active' : ''}`}
                onClick={() => setSignerMode('single')}
              >
                ▣ Single Key Session
              </button>
              <button
                type="button"
                className={`signer-tab-btn ${signerMode === 'csv' ? 'active' : ''}`}
                onClick={() => setSignerMode('csv')}
              >
                ☵ CSV Batch Wallets {csvQueue.length > 0 ? `(${csvQueue.length})` : ''}
              </button>
            </div>

            {signerMode === 'csv' ? (
              <div className="csv-panel">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  ref={csvFileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleCsvFileUpload}
                />
                <div className="csv-actions-bar">
                  <button
                    type="button"
                    className="csv-load-template-btn"
                    onClick={() => void loadDefaultChainCsv(vault)}
                    disabled={csvLoading || batchRunning}
                  >
                    {csvLoading ? 'LOADING…' : `⭳ LOAD DEFAULT ${vault.chainType.toUpperCase()} CSV`}
                  </button>
                  <button
                    type="button"
                    className="csv-load-template-btn"
                    onClick={() => csvFileInputRef.current?.click()}
                    disabled={csvLoading || batchRunning}
                  >
                    ↑ UPLOAD CSV
                  </button>
                  {csvQueue.length > 0 && (
                    <button
                      type="button"
                      className="csv-clear-btn"
                      onClick={() => { setCsvQueue([]); setCsvError(null); }}
                      disabled={batchRunning}
                    >
                      CLEAR
                    </button>
                  )}
                </div>

                {csvError && <p className="form-error" role="alert">{csvError}</p>}

                {csvQueue.length === 0 ? (
                  <div
                    className="csv-dropzone"
                    onClick={() => csvFileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        const fakeEvent = { target: { files: [file], value: '' } } as any;
                        handleCsvFileUpload(fakeEvent);
                      }
                    }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="12" y1="18" x2="12" y2="12" />
                      <line x1="9" y1="15" x2="15" y2="15" />
                    </svg>
                    <span className="csv-dropzone-title">Upload Wallets CSV file or load chain default</span>
                    <span className="csv-dropzone-sub">Columns: wallet_address, private_key, amount, scheduled_time</span>
                  </div>
                ) : (
                  <>
                    <div className="csv-queue-summary">
                      <span>Total: <strong>{csvQueue.length}</strong></span>
                      <span>Pending: <strong>{csvQueue.filter((q) => q.status === 'Pending').length}</strong></span>
                      <span>Success: <strong style={{ color: '#22c55e' }}>{csvQueue.filter((q) => q.status === 'Success').length}</strong></span>
                      <span>Failed: <strong style={{ color: '#ef4444' }}>{csvQueue.filter((q) => q.status === 'Failed').length}</strong></span>
                    </div>

                    <div className="csv-queue-scroll">
                      <table className="csv-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>WALLET</th>
                            <th>AMOUNT</th>
                            <th>SCHEDULE</th>
                            <th>STATUS</th>
                            <th>TX / ERROR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {csvQueue.map((item, idx) => {
                            const isCurrent = batchActiveIndex === idx;
                            return (
                              <tr key={item.id} style={isCurrent ? { background: 'rgba(56, 189, 248, 0.12)' } : undefined}>
                                <td>{idx + 1}</td>
                                <td title={item.address}>
                                  <code>{item.address ? `${item.address.slice(0, 6)}…${item.address.slice(-4)}` : '—'}</code>
                                </td>
                                <td><strong>{item.amount} {activeVaultAsset.symbol}</strong></td>
                                <td><small>{item.scheduledTime || 'Immediate'}</small></td>
                                <td>
                                  <span className={`queue-status-badge ${item.status.toLowerCase()}`}>
                                    {item.status}
                                  </span>
                                </td>
                                <td>
                                  {item.txHash ? (
                                    <a
                                      href={
                                        isEvmChain(vault.chainType)
                                          ? `${currentVaultEvmConfig.explorerUrl}/tx/${item.txHash}`
                                          : `${chainConfig.explorerUrl}/tx/${item.txHash}`
                                      }
                                      target="_blank"
                                      rel="noreferrer"
                                      className="tx-hash-link"
                                      title="View on explorer"
                                    >
                                      <code>{item.txHash.slice(0, 8)}…</code>
                                    </a>
                                  ) : item.error ? (
                                    <span style={{ color: '#ef4444', whiteSpace: 'normal', display: 'inline-block', maxWidth: 320 }} title={item.error}>
                                      {item.error}
                                    </span>
                                  ) : (
                                    <span>—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {batchRunning && (
                      <div className="batch-progress-bar">
                        <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                          <path d="M12 2a10 10 0 0 1 10 10" />
                        </svg>
                        <span>
                          Running on server: wallet {(batchActiveIndex ?? 0) + 1} of {csvQueue.length} · Delay: {automation.interval || 2}s · safe to close this tab
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : walletSession.source ? (
              <div className="connection-panel">
                <div className="connection-heading">
                  <span className="connection-mark">✓</span>
                  <div>
                    <small>SESSION UNLOCKED · {vault.pair} ({vault.chainType === 'bnb' ? 'BNB CHAIN' : vault.chainType === 'erc' ? 'ERC / EVM' : 'ZIGCHAIN'})</small>
                    <h3>Signer active in memory</h3>
                  </div>
                  <span className="connection-method">PRIVATE KEY</span>
                </div>
                <div className="connected-account">
                  <span>UNLOCKED ADDRESS</span>
                  <code>{walletSession.address}</code>
                  <span>AVAILABLE {currentTokenSymbol} BALANCE</span>
                  <strong>{formatBaseUnits(walletSession.balanceBaseUnits, currentTokenDecimals)} {currentTokenSymbol}</strong>
                  {isEvmChain(vault.chainType) && !activeVaultAsset.isNative && (
                    <>
                      <span style={{ marginTop: '10px' }}>GAS RESERVE ({vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'})</span>
                      <strong className={BigInt(walletSession.nativeGasBaseUnits || '0') === 0n ? 'gas-zero-warning' : ''}>
                        {formatBaseUnits(walletSession.nativeGasBaseUnits, 18)} {vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'}
                      </strong>
                    </>
                  )}
                </div>
                <p>Session signer resides in memory and never leaves this tab. Close or clear this session when finished.</p>
                <button className="disconnect-button" type="button" onClick={() => void disconnectWallet(selectedVault)}>
                  CLEAR SESSION & SECRETS
                </button>
              </div>
            ) : (
              <div className="private-form">
                <div className="chain-info-banner">
                  <span>NETWORK:</span>
                  <strong>
                    {vault.chainType === 'bnb'
                      ? 'BNB Smart Chain Mainnet (BSC)'
                      : vault.chainType === 'erc'
                      ? 'EVM / ERC-Compatible'
                      : `${chainConfig.name} (${chainConfig.id})`}
                  </strong>
                </div>
                <label>
                  <span>WALLET ADDRESS (OPTIONAL VERIFICATION)</span>
                  <input
                    value={walletSession.manualAddress}
                    onChange={(event) => patchWalletSession(selectedVault, { manualAddress: event.target.value })}
                    placeholder={isEvmChain(vault.chainType) ? '0x...' : 'zig1...'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  <span>PRIVATE KEY OR MNEMONIC</span>
                  <input
                    ref={secretInputRef}
                    type="password"
                    placeholder="32-byte hex key or 12/24-word phrase"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </label>
                <div className="warning-note">
                  <b>!</b>
                  <p>
                    <strong>Where your key goes.</strong> For Send Once it stays in this browser&apos;s memory and is cleared on refresh, close or Clear Session. Starting an automation or CSV batch sends it to the server, which stores it encrypted so sends continue with this tab closed, and wipes it when the automation is stopped or the batch ends.
                  </p>
                </div>
                <button className="unlock-button" type="button" onClick={() => void unlockManualSession(selectedVault)} disabled={walletSession.unlocking}>
                  {walletSession.unlocking ? 'DERIVING SIGNER…' : 'UNLOCK SESSION'}
                </button>
                {walletSession.error && <p className="form-error" role="alert">{walletSession.error}</p>}
              </div>
            )}
          </article>

          {/* Vault Card */}
          <article className="console-card vault-card">
            <div className="card-title">
              <span className={`title-icon ${vault.accent}`}>◇</span>
              <div>
                <h2>Vault Details</h2>
                <p>Target destination configuration.</p>
              </div>
              <button className="card-add-vault-btn" type="button" onClick={() => setAddVaultOpen(true)}>
                + ADD VAULT
              </button>
            </div>
            <div className="vault-nameplate">
              <span className={`vault-badge ${vault.accent}`}>{vault.pair}</span>
              <div>
                <small>
                  {vault.chainType === 'bnb'
                    ? 'BNB SMART CHAIN (BSC)'
                    : vault.chainType === 'erc'
                    ? 'ETHEREUM MAINNET (EVM)'
                    : 'ZIGCHAIN STRATEGY'}
                </small>
                <strong>{vault.name}</strong>
              </div>
              <span className={vault.address && vault.address !== 'Not configured' ? 'configured' : 'not-configured'}>
                {vault.address && vault.address !== 'Not configured' ? 'READY' : 'NOT CONFIGURED'}
              </span>
            </div>
            <p className="vault-summary">{vault.summary}</p>
            <div className="market-snapshot">
              <div><span>TVL</span><strong>{vault.tvl}</strong></div>
              <div><span>Vault APY</span><strong>{vault.apy}</strong></div>
              <div><span>Type</span><strong>{vault.type}</strong></div>
              <div><span>Risk</span><strong>{vault.risk}</strong></div>
            </div>
            <p className="snapshot-note">Verified vault contract destination</p>
            <div className="detail-list">
              <div><span>Vault Target</span><code>{vault.address}</code></div>
              <div>
                <span>Deposit Asset</span>
                <strong>
                  {activeVaultAsset.symbol}
                  {activeVaultAsset.isDetected ? ' (Auto-detected)' : ''}
                </strong>
              </div>
              {activeVaultAsset.address && (
                <div><span>Token Contract</span><code>{activeVaultAsset.address.slice(0, 10)}…{activeVaultAsset.address.slice(-6)}</code></div>
              )}
              <div><span>Token Balance</span><strong>{walletSession.address ? `${formatBaseUnits(walletSession.balanceBaseUnits, currentTokenDecimals)} ${currentTokenSymbol}` : '—'}</strong></div>
              {isEvmChain(vault.chainType) && (
                <div>
                  <span>{vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'} Gas Reserve</span>
                  <strong className={BigInt(walletSession.nativeGasBaseUnits || '0') === 0n && walletSession.address ? 'gas-zero-warning' : ''}>
                    {walletSession.address ? `${formatBaseUnits(walletSession.nativeGasBaseUnits, 18)} ${vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'}` : '—'}
                  </strong>
                </div>
              )}
              <div><span>Decimals</span><strong>{currentTokenDecimals}</strong></div>
              <div><span>Total Transferred</span><strong>{formatBaseUnits(totalTransferred, currentTokenDecimals)} {currentTokenSymbol}</strong></div>
              <div><span>Execution Count</span><strong>{successfulHistory.length}</strong></div>
            </div>
            {isEvmChain(vault.chainType) && walletSession.address && BigInt(walletSession.nativeGasBaseUnits || '0') === 0n && (
              <div className="gas-warning-notice">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
                <span>Wallet has 0 {vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'} for gas. Fund your wallet with {vault.chainType === 'bnb' ? (currentVaultEvmConfig.chainId === 97 ? 'tBNB' : 'BNB') : 'ETH'} on this network to execute transactions.</span>
              </div>
            )}
            <div className="interface-banner">
              <span>⌁</span>
              <div>
                <strong>{vault.address && vault.address !== 'Not configured' ? `${vault.chainType === 'bnb' ? 'BNB CHAIN' : vault.chainType === 'erc' ? 'ERC / EVM' : 'COSMOS'} TRANSFER READY` : 'VAULT_NOT_CONFIGURED'}</strong>
                <small>
                  {vault.chainType === 'bnb'
                    ? `Transfers execute on BNB Smart Chain Mainnet (${currentVaultEvmConfig.rpcUrl}) with direct private key execution.`
                    : vault.chainType === 'erc'
                    ? `Transfers execute on Ethereum Mainnet (${currentVaultEvmConfig.rpcUrl}) with direct private key execution.`
                    : `Transfers execute on ${chainConfig.name} with standard Cosmos signing.`}
                </small>
              </div>
            </div>
          </article>
        </section>

        {/* Strategy Configuration */}
        <section className="console-card strategy-card">
          <div className="card-title">
            <span className="title-icon orange">◷</span>
            <div>
              <h2>Strategy Configuration</h2>
              <p>Independent schedule and amounts for {vault.name}.</p>
            </div>
            <span className="independent-pill">INDEPENDENT SCHEDULE</span>
          </div>

          <div className="delivery-mode" aria-label="Transfer mode">
            <button className={automation.mode === 'once' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('once')}>
              <strong>Send once</strong>
              <small>One transfer using an exact amount</small>
            </button>
            <button className={automation.mode === 'automation' ? 'active' : ''} type="button" disabled={automation.status === 'running'} onClick={() => selectDeliveryMode('automation')}>
              <strong>Automation</strong>
              <small>Repeat within an amount range</small>
            </button>
          </div>

          <div className="direction-bar">
            <span className="active">SOURCE WALLET <b>→</b> {vault.name.toUpperCase()}</span>
            <span>{vault.chainType === 'bnb' ? 'BNB CHAIN TRANSFER' : vault.chainType === 'erc' ? 'EVM TRANSFER' : 'COSMOS TRANSFER'}</span>
          </div>

          {/* Deposit Asset Selector */}
          <div className="deposit-asset-section">
            <div className="deposit-asset-header">
              <span className="deposit-asset-title">SELECT DEPOSIT ASSET</span>
              {activeVaultAsset.isDetected && (
                <span className="auto-detected-badge">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Auto-detected from vault contract
                </span>
              )}
            </div>
            <div className="asset-pill-group">
              {availableVaultAssets.map((asset) => {
                const isSelected = activeVaultAsset.symbol === asset.symbol;
                return (
                  <button
                    key={asset.symbol}
                    type="button"
                    className={`asset-pill-btn ${isSelected ? 'active' : ''}`}
                    disabled={automation.status === 'running'}
                    onClick={() => handleSelectVaultAsset(selectedVault, asset)}
                  >
                    <div className="pill-top">
                      <strong>{asset.symbol}</strong>
                      {asset.isDetected && <span className="pill-detected-badge">Vault Preferred</span>}
                    </div>
                    <small>{asset.isNative ? 'Native Gas Token' : `${asset.name || asset.symbol} · ${asset.decimals} Dec`}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`amount-grid ${automation.mode === 'once' ? 'single' : ''}`}>
            <label>
              <span>{automation.mode === 'once' ? 'AMOUNT TO SEND' : 'MINIMUM AMOUNT'}</span>
              <div>
                <input
                  value={automation.minimum}
                  onChange={(event) => updateSelectedAutomation({ minimum: event.target.value })}
                  disabled={automation.status === 'running'}
                  inputMode="decimal"
                  placeholder="e.g. 0.1"
                />
                <b>{currentTokenSymbol}</b>
              </div>
            </label>
            <label className="max-field" aria-hidden={automation.mode === 'once'}>
              <span>MAXIMUM AMOUNT</span>
              <div>
                <input
                  value={automation.maximum}
                  onChange={(event) => updateSelectedAutomation({ maximum: event.target.value })}
                  disabled={automation.status === 'running' || automation.mode === 'once'}
                  inputMode="decimal"
                  placeholder="Blank uses minimum"
                  tabIndex={automation.mode === 'once' ? -1 : 0}
                />
                <b>{currentTokenSymbol}</b>
              </div>
            </label>
          </div>

          <div className="amount-note">
            <b>Note:</b> {signerMode === 'csv'
              ? `CSV Batch Mode: Deposit amounts are configured per wallet row in the CSV queue (${csvQueue.length} wallets). Transactions invoke deposit(0xb6b55f25) with automatic token approval.`
              : automation.mode === 'once'
              ? 'Send once transfers exactly the amount entered above.'
              : 'Each run chooses an amount between minimum and maximum. Failed transactions automatically pause this vault.'}{' '}
            {currentTokenSymbol} uses {currentTokenDecimals} decimals.
          </div>

          {actionHint && <p className="action-hint">{actionHint}</p>}
          {transferStatus && (
            <div className={`transfer-status ${transferStatus.kind}`} role="status">
              <strong>{transferStatus.kind === 'success' ? 'TRANSFER CONFIRMED' : 'TRANSFER NOT SENT'}</strong>
              <span>{transferStatus.message}</span>
              {transferStatus.hash && <code>{transferStatus.hash}</code>}
            </div>
          )}

          <div className={`automation-fields ${automation.mode === 'automation' || signerMode === 'csv' ? 'expanded' : ''}`} aria-hidden={automation.mode !== 'automation' && signerMode !== 'csv'}>
            <div>
              <div className="frequency-row">
                <div>
                  <span>EXECUTION FREQUENCY</span>
                  <small>{signerMode === 'csv' ? 'Delay between each sequential wallet deposit in queue' : 'Choose a preset or set your own interval'}</small>
                </div>
                <div className="frequency-options">
                  {intervals.map((item) => (
                    <button
                      className={!automation.customInterval && automation.interval === item.value ? 'active' : ''}
                      key={item.value}
                      type="button"
                      disabled={automation.status === 'running' || batchRunning}
                      onClick={() => updateSelectedAutomation({ interval: item.value, customInterval: '' })}
                    >
                      {item.label}
                    </button>
                  ))}
                  <label className={automation.customInterval ? 'custom-frequency active' : 'custom-frequency'}>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={automation.customInterval}
                      disabled={automation.status === 'running' || batchRunning}
                      onChange={(event) => setCustomFrequency(event.target.value)}
                      placeholder="Custom"
                      tabIndex={0}
                    />
                    <span>sec</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="execution-strip">
            <div>
              <span className={`execution-light ${signerMode === 'csv' ? (batchRunning ? 'running' : 'stopped') : automation.status}`} />
              <span>
                <small>CURRENT STATUS</small>
                <strong>
                  {signerMode === 'csv'
                    ? (batchRunning ? `BATCH ACTIVE (${(batchActiveIndex ?? 0) + 1}/${csvQueue.length})` : csvQueue.length ? 'BATCH READY' : 'CSV EMPTY')
                    : (sendingVaults.includes(selectedVault) || automation.inFlight ? 'SENDING' : automation.mode === 'once' ? 'READY' : statusLabel)}
                </strong>
                {signerMode !== 'csv' && automation.mode === 'automation' && automation.status === 'paused' && automation.lastError ? (
                  <small style={{ color: '#ef4444', display: 'block', maxWidth: 360, whiteSpace: 'normal' }} title={automation.lastError}>{automation.lastError}</small>
                ) : null}
              </span>
            </div>
            <div>
              <small>LAST EXECUTION</small>
              <strong>{automation.lastAt ? new Date(automation.lastAt).toLocaleTimeString() : 'Never'}</strong>
            </div>
            <div>
              <small>NEXT EXECUTION</small>
              <strong>
                {signerMode === 'csv'
                  ? (batchRunning ? `Delay: ${automation.interval || 2}s` : 'Manual batch trigger')
                  : automation.mode === 'once'
                  ? 'Not scheduled'
                  : sendingVaults.includes(selectedVault) || automation.inFlight
                  ? 'Executing now…'
                  : automation.status === 'running' && !serverState?.workerOnline
                  ? 'Waiting for worker'
                  : automation.status === 'running'
                  ? formatCountdown(automation.nextAt, now)
                  : '—'}
              </strong>
            </div>
            <div className="strategy-actions">
              {signerMode === 'csv' ? (
                <>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => void stopBatchAutomation()}
                    disabled={!batchRunning}
                  >
                    STOP BATCH
                  </button>
                  <button
                    className="start primary-action"
                    type="button"
                    onClick={() => void startBatchAutomation()}
                    disabled={batchRunning || csvQueue.length === 0 || !vault.address || vault.address === 'Not configured'}
                  >
                    {batchRunning ? 'BATCH RUNNING ON SERVER…' : `START BATCH DEPOSIT (${csvQueue.length} WALLETS)`}
                  </button>
                </>
              ) : automation.mode === 'once' ? (
                <button
                  className="manual-send primary-action"
                  type="button"
                  onClick={sendManualTransfer}
                  disabled={!canSend(selectedVault) || sendingVaults.includes(selectedVault)}
                >
                  SEND ONCE
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => void pauseAutomation(selectedVault)} disabled={automation.status !== 'running'}>
                    PAUSE
                  </button>
                  <button className="danger" type="button" onClick={() => void stopAutomation(selectedVault)} disabled={automation.status === 'stopped'}>
                    STOP
                  </button>
                  <button
                    className="start"
                    type="button"
                    onClick={() => void startAutomation(selectedVault)}
                    disabled={!canStartOrResume(selectedVault)}
                  >
                    {automation.status === 'paused' ? 'RESUME' : 'START AUTOMATION'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* History */}
        <section className="console-card history-card">
          <div className="history-header">
            <div className="card-title">
              <span className="title-icon purple">↗</span>
              <div>
                <h2>Transaction History</h2>
                <p>{vault.pair} · {vault.name}</p>
              </div>
            </div>
            <div className="history-filters">
              {['All', 'Success', 'Pending', 'Failed'].map((item) => (
                <button className={historyFilter === item ? 'active' : ''} type="button" key={item} onClick={() => setHistoryFilter(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="table-head">
            <span>TIME</span>
            <span>AMOUNT</span>
            <span>STATUS</span>
            <span>TRANSACTION</span>
          </div>
          {selectedHistory.length ? (
            selectedHistory.map((entry) => (
              <div className="history-row" key={entry.id} title={entry.error}>
                <span>{new Date(entry.time).toLocaleTimeString()} <small>{entry.source}</small></span>
                <strong>{formatBaseUnits(entry.amountBaseUnits, currentTokenDecimals)} {currentTokenSymbol}</strong>
                <span className={`history-status ${entry.status.toLowerCase()}`}>{entry.status}</span>
                <div className="tx-cell">
                  {entry.hash ? (
                    <a
                      href={
                        isEvmChain(vault.chainType)
                          ? `${currentVaultEvmConfig.explorerUrl}/tx/${entry.hash}`
                          : `${chainConfig.explorerUrl}/tx/${entry.hash}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="tx-hash-link"
                      title="View transaction on block explorer"
                    >
                      <code>{`${entry.hash.slice(0, 10)}…${entry.hash.slice(-6)}`}</code>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  ) : (
                    <code>{entry.error ? entry.error.slice(0, 34) : 'Broadcasting…'}</code>
                  )}
                  {entry.hash && (
                    <button
                      className={copiedHash === entry.hash ? 'copied' : ''}
                      type="button"
                      aria-label={copiedHash === entry.hash ? 'Transaction hash copied' : 'Copy transaction hash'}
                      title={copiedHash === entry.hash ? 'Copied' : 'Copy transaction hash'}
                      onClick={() => void copyTransactionHash(entry.hash!)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="history-empty">
              <span>↗</span>
              <strong>No {historyFilter.toLowerCase()} transactions</strong>
              <p>Transactions for this wallet and vault will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
