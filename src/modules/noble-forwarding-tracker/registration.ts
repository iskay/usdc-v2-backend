import protobuf from 'protobufjs/light.js';
import { bech32 } from 'bech32';
import Long from 'long';
import {
  TxBody,
  AuthInfo,
  SignerInfo,
  ModeInfo,
  Fee,
  TxRaw
} from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { Any } from 'cosmjs-types/google/protobuf/any.js';
import type { AppLogger } from '../../common/utils/logger.js';

export interface RegistrationTransactionParams {
  nobleAddress: string;
  recipient: string;
  channel: string;
  fallback: string;
  gasLimit: number;
  feeAmount: string; // uusdc amount as string
}

export interface RegistrationTransactionResult {
  txBytes: string; // base64-encoded transaction bytes
}

/**
 * Build a signerless registration transaction for Noble forwarding
 * Reference: usdc-mockup-backend/src/index.js lines 101-163
 */
export function buildRegistrationTransaction(
  params: RegistrationTransactionParams,
  logger: AppLogger
): RegistrationTransactionResult {
  try {
    logger.debug({ nobleAddress: params.nobleAddress }, 'Building Noble forwarding registration transaction');

    // Build protobuf types dynamically using Root and namespace
    const root = new protobuf.Root();
    const ns = root.define('noble.forwarding.v1');

    const ForwardingPubKey = new protobuf.Type('ForwardingPubKey').add(
      new protobuf.Field('key', 1, 'bytes')
    );
    ns.add(ForwardingPubKey);

    const MsgRegisterAccount = new protobuf.Type('MsgRegisterAccount')
      .add(new protobuf.Field('signer', 1, 'string'))
      .add(new protobuf.Field('recipient', 2, 'string'))
      .add(new protobuf.Field('channel', 3, 'string'))
      .add(new protobuf.Field('fallback', 4, 'string'));
    ns.add(MsgRegisterAccount);

    // Decode noble bech32 address to raw 20 bytes for ForwardingPubKey
    const decoded = bech32.decode(params.nobleAddress);
    const raw = bech32.fromWords(decoded.words);
    const rawBytes = new Uint8Array(raw);
    if (rawBytes.length !== 20) {
      throw new Error(`Invalid noble address bytes length: expected 20, got ${rawBytes.length}`);
    }

    // Create MsgRegisterAccount message
    const msg = MsgRegisterAccount.create({
      signer: params.nobleAddress,
      recipient: params.recipient,
      channel: params.channel,
      fallback: params.fallback
    });
    const msgBytes = MsgRegisterAccount.encode(msg).finish();
    const msgAny = Any.fromPartial({
      typeUrl: '/noble.forwarding.v1.MsgRegisterAccount',
      value: msgBytes
    });

    // Build TxBody
    const bodyBytes = TxBody.encode(
      TxBody.fromPartial({
        messages: [msgAny],
        memo: ''
      })
    ).finish();

    // Build ForwardingPubKey
    const pkBytes = ForwardingPubKey.encode({ key: rawBytes }).finish();
    const pkAny = Any.fromPartial({
      typeUrl: '/noble.forwarding.v1.ForwardingPubKey',
      value: pkBytes
    });

    // Build AuthInfo with signerless signature (empty signature)
    const modeInfo = ModeInfo.fromPartial({
      single: { mode: 1 } // SIGN_MODE_DIRECT
    });
    const signerInfo = SignerInfo.fromPartial({
      publicKey: pkAny,
      modeInfo,
      sequence: Long.UZERO
    });

    const fee = Fee.fromPartial({
      gasLimit: Long.fromNumber(params.gasLimit),
      amount: [{ denom: 'uusdc', amount: params.feeAmount }]
    });

    const authInfoBytes = AuthInfo.encode(
      AuthInfo.fromPartial({
        signerInfos: [signerInfo],
        fee
      })
    ).finish();

    // Build TxRaw with empty signatures (signerless)
    const txRawBytes = TxRaw.encode(
      TxRaw.fromPartial({
        bodyBytes,
        authInfoBytes,
        signatures: [new Uint8Array()] // Empty signature for signerless transaction
      })
    ).finish();

    // Encode to base64 for broadcast
    const txBase64 = Buffer.from(txRawBytes).toString('base64');

    logger.debug({ nobleAddress: params.nobleAddress }, 'Successfully built registration transaction');

    return {
      txBytes: txBase64
    };
  } catch (error) {
    logger.error(
      { err: error, nobleAddress: params.nobleAddress },
      'Failed to build registration transaction'
    );
    throw error;
  }
}

