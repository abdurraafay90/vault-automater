import { DirectSecp256k1HdWallet, type EncodeObject, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, StargateClient, type DeliverTxResponse } from '@cosmjs/stargate';

const BIGINT_ZERO = BigInt(0);
const MILLISECONDS_TO_NANOSECONDS = BigInt(1000000);

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

type IbcTransferOptions = {
  readonly denom?: string;
  readonly sourcePort?: string;
  readonly sourceChannel?: string;
  readonly timeoutSeconds?: number;
  readonly memo?: string;
  readonly gasPrice?: string;
};

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
  options: IbcTransferOptions = {},
): Promise<DeliverTxResponse> {
  if (amountBaseUnits <= BIGINT_ZERO) throw new RangeError('TRANSFER_AMOUNT_MUST_BE_POSITIVE');
  const [account] = await signer.getAccounts();
  if (!account) throw new Error('SIGNER_HAS_NO_ACCOUNT');
  const client = await SigningStargateClient.connectWithSigner(rpcUrl, signer, { gasPrice: GasPrice.fromString(options.gasPrice ?? ZIG_TESTNET.gasPrice) });
  try {
    const message: EncodeObject = {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: {
        sourcePort: options.sourcePort ?? 'transfer',
        sourceChannel: options.sourceChannel ?? 'channel-3',
        token: { denom: options.denom ?? ZIG_TESTNET.denom, amount: amountBaseUnits.toString() },
        sender: account.address,
        receiver: recipientAddress,
        timeoutHeight: { revisionNumber: BIGINT_ZERO, revisionHeight: BIGINT_ZERO },
        timeoutTimestamp: BigInt(Date.now() + ((options.timeoutSeconds ?? 600) * 1000)) * MILLISECONDS_TO_NANOSECONDS,
        memo: options.memo ?? '',
      },
    };
    return await client.signAndBroadcast(account.address, [message], 'auto');
  } finally {
    client.disconnect();
  }
}
