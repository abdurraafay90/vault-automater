import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, type EncodeObject, type OfflineSigner } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, coin } from '@cosmjs/stargate';
import { formatBaseUnits, hexToBytes } from './amounts.js';
import type { StablecoinAsset } from './chains.js';
import { ExecutionError, type TransferResult } from './errors.js';

const GAS_MULTIPLIER = 1.5;
const MS_TO_NS = 1_000_000n;

export type OrbiterConfig = {
  enabled: boolean;
  feeRecipient: string;
  feeAmount: string;
  destinationDomain: number;
  mintRecipient: string;
  destinationCaller: string;
  passthroughPayload: string;
};

export type IbcConfig = {
  sourcePort: string;
  sourceChannel: string;
  timeoutSeconds: number;
  orbiter: OrbiterConfig;
};

export async function zigSignerFromSecret(secret: string): Promise<OfflineSigner> {
  const trimmed = secret.trim();
  return /\s/.test(trimmed)
    ? DirectSecp256k1HdWallet.fromMnemonic(trimmed, { prefix: 'zig' })
    : DirectSecp256k1Wallet.fromKey(hexToBytes(trimmed), 'zig');
}

function buildOrbiterMemo(settings: OrbiterConfig): string {
  if (!settings.enabled) return '';
  if (!settings.mintRecipient || !settings.destinationCaller) {
    throw new ExecutionError('Orbiter CCTP memo is missing mint recipient or destination caller.');
  }
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

export type ZigTransferInput = {
  secret: string;
  rpcUrl: string;
  gasDenom: string;
  vaultAddress: string;
  asset: StablecoinAsset;
  amount: bigint;
  ibc: IbcConfig;
};

/**
 * Same behaviour as the console's browser send path: MsgSend to a zig1 address,
 * otherwise an IBC MsgTransfer. The transferred denom is the asset's (Noble
 * USDC); gas is always paid separately in the native denom.
 */
export async function sendZigStablecoin(input: ZigTransferInput): Promise<TransferResult> {
  const { asset, amount, vaultAddress, gasDenom } = input;
  if (!asset.denom) throw new ExecutionError(`${asset.symbol} has no bank denom on ZIGChain.`);
  if (!input.rpcUrl) throw new ExecutionError('ZIGChain RPC_URL is not configured.');

  const signer = await zigSignerFromSecret(input.secret);
  const [account] = await signer.getAccounts();
  if (!account) throw new ExecutionError('No ZIGChain account could be derived from the key.');
  const who = `${account.address.slice(0, 8)}…${account.address.slice(-4)}`;

  const client = await SigningStargateClient.connectWithSigner(input.rpcUrl, signer, {
    gasPrice: GasPrice.fromString(`0.025${gasDenom}`),
  });
  try {
    const balance = BigInt((await client.getBalance(account.address, asset.denom)).amount);
    if (balance < amount) {
      throw new ExecutionError(`Insufficient balance: ${who} holds ${formatBaseUnits(balance, asset.decimals)} ${asset.symbol}, needs ${formatBaseUnits(amount, asset.decimals)} ${asset.symbol}.`);
    }
    const gasBalance = BigInt((await client.getBalance(account.address, gasDenom)).amount);
    if (gasBalance === 0n) throw new ExecutionError(`Insufficient funds for gas: ${who} holds 0 ${gasDenom}.`);

    if (vaultAddress.startsWith('zig1')) {
      const result = await client.sendTokens(account.address, vaultAddress, [coin(amount.toString(), asset.denom)], GAS_MULTIPLIER);
      if (result.code !== 0) throw new ExecutionError(result.rawLog || `ZIGChain transaction failed with code ${result.code}.`, result.transactionHash);
      return { hash: result.transactionHash, method: 'bank-send' };
    }

    const { ibc } = input;
    const message: EncodeObject = {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: {
        sourcePort: ibc.sourcePort,
        sourceChannel: ibc.sourceChannel,
        token: { denom: asset.denom, amount: amount.toString() },
        sender: account.address,
        receiver: vaultAddress,
        timeoutHeight: { revisionNumber: 0n, revisionHeight: 0n },
        timeoutTimestamp: BigInt(Date.now() + ibc.timeoutSeconds * 1000) * MS_TO_NS,
        memo: buildOrbiterMemo(ibc.orbiter),
      },
    };
    const result = await client.signAndBroadcast(account.address, [message], GAS_MULTIPLIER);
    if (result.code !== 0) throw new ExecutionError(result.rawLog || `IBC transfer failed with code ${result.code}.`, result.transactionHash);
    return { hash: result.transactionHash, method: 'ibc-transfer' };
  } finally {
    client.disconnect();
  }
}
