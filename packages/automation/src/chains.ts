export type ChainType = 'zigchain' | 'erc' | 'bnb';
export type EvmChainType = Exclude<ChainType, 'zigchain'>;

export type StablecoinSymbol = 'USDT' | 'USDC';

export type StablecoinAsset = {
  readonly chainType: ChainType;
  readonly symbol: StablecoinSymbol;
  readonly decimals: number;
  /** ERC-20 / BEP-20 contract. Set for EVM chains only. */
  readonly address?: string;
  /** Cosmos bank denom. Set for ZIGChain only. */
  readonly denom?: string;
};

// Keyless public mainnet RPCs, each verified against the app's real workload
// (eth_call, eth_getBalance, eth_getCode) and for head staleness. Index 0 is
// primary; the rest are ordered fallbacks.
export const DEFAULT_ETH_RPC_URLS: readonly string[] = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.mevblocker.io',
  'https://eth.blockrazor.xyz',
  'https://eth-pokt.nodies.app',
  'https://gateway.tenderly.co/public/mainnet',
];

export const DEFAULT_BSC_RPC_URLS: readonly string[] = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.rpc.blxrbdn.com',
];

export const EVM_CHAIN_IDS: Readonly<Record<EvmChainType, number>> = { erc: 1, bnb: 56 };
export const EVM_GAS_SYMBOLS: Readonly<Record<EvmChainType, string>> = { erc: 'ETH', bnb: 'BNB' };

// Noble USDC bridged over transfer/channel-3: SHA256("transfer/channel-3/uusdc").
export const ZIGCHAIN_USDC_DENOM = 'ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4';

/**
 * The only assets automation may move. Decimals come from here, never from the
 * client: USDT/USDC are 6 decimals on Ethereum but 18 on BNB Smart Chain.
 */
export const STABLECOINS: readonly StablecoinAsset[] = [
  { chainType: 'erc', symbol: 'USDT', decimals: 6, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  { chainType: 'erc', symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainType: 'bnb', symbol: 'USDT', decimals: 18, address: '0x55d398326f99059fF775485246999027B3197955' },
  { chainType: 'bnb', symbol: 'USDC', decimals: 18, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  { chainType: 'zigchain', symbol: 'USDC', decimals: 6, denom: ZIGCHAIN_USDC_DENOM },
];

export function findStablecoin(chainType: ChainType, symbol: string): StablecoinAsset | undefined {
  return STABLECOINS.find((asset) => asset.chainType === chainType && asset.symbol === symbol.toUpperCase());
}

export function isEvmChain(chainType: ChainType): chainType is EvmChainType {
  return chainType === 'erc' || chainType === 'bnb';
}

export function isValidVaultAddress(chainType: ChainType, address: string): boolean {
  return chainType === 'zigchain'
    ? /^zig1[0-9a-z]{38,62}$/.test(address)
    : /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function splitUrlList(value: string | undefined, fallback: readonly string[]): string[] {
  const list = (value ?? '').split(',').map((url) => url.trim()).filter(Boolean);
  return list.length > 0 ? list : [...fallback];
}
