import { DirectSecp256k1HdWallet, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, StargateClient, coin, type DeliverTxResponse } from '@cosmjs/stargate';

export const ZIG_TESTNET = {
  chainId: 'zig-test-2',
  chainName: 'ZIGChain Testnet',
  rpcUrl: 'https://testnet-rpc.zigchain.com',
  apiUrl: 'https://testnet-api.zigchain.com',
  addressPrefix: 'zig',
  denom: 'uzig',
  symbol: 'ZIG',
  decimals: 6,
  gasPrice: '0.025uzig',
} as const;

export async function queryZigBalance(address: string, rpcUrl = ZIG_TESTNET.rpcUrl): Promise<bigint> {
  const client = await StargateClient.connect(rpcUrl);
  try {
    const balance = await client.getBalance(address, ZIG_TESTNET.denom);
    return BigInt(balance.amount);
  } finally {
    client.disconnect();
  }
}

export async function createDevelopmentMnemonicSigner(mnemonic: string): Promise<DirectSecp256k1HdWallet> {
  if (!mnemonic.trim()) throw new Error('BACKEND_SIGNER_UNAVAILABLE');
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: ZIG_TESTNET.addressPrefix });
}

export async function sendZig(
  signer: OfflineSigner,
  recipientAddress: string,
  amountBaseUnits: bigint,
  rpcUrl = ZIG_TESTNET.rpcUrl,
): Promise<DeliverTxResponse> {
  if (amountBaseUnits <= 0n) throw new RangeError('TRANSFER_AMOUNT_MUST_BE_POSITIVE');
  const [account] = await signer.getAccounts();
  if (!account) throw new Error('SIGNER_HAS_NO_ACCOUNT');
  const client = await SigningStargateClient.connectWithSigner(rpcUrl, signer, { gasPrice: GasPrice.fromString(ZIG_TESTNET.gasPrice) });
  try {
    return await client.sendTokens(account.address, recipientAddress, [coin(amountBaseUnits.toString(), ZIG_TESTNET.denom)], 'auto');
  } finally {
    client.disconnect();
  }
}
