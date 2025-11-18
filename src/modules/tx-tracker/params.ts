import type { FlowTrackingParams } from './trackerManager.js';
import type { ChainProgress, ChainProgressEntry, FlowType, TrackedTransaction } from './types.js';
import type { ChainRegistry } from '../../config/chainRegistry.js';

function getString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Convert EVM hex20 address to base64-encoded bytes32 format.
 * This is required by Orbiter for mint_recipient and destination_caller fields.
 * Mirrors the frontend implementation in orbiterPayloadService.ts
 */
function evmHex20ToBase64Bytes32(evmHex20: string): string {
  // Remove 0x prefix if present
  const cleanHex = evmHex20.startsWith('0x') ? evmHex20.slice(2) : evmHex20;
  
  // Validate hex string length (should be 40 chars for 20 bytes)
  if (cleanHex.length !== 40 || !/^[0-9a-f]+$/i.test(cleanHex)) {
    throw new Error(`Invalid EVM address: ${evmHex20}`);
  }
  
  // Convert hex to bytes
  const bytes = Buffer.from(cleanHex, 'hex');
  
  // Left-pad to 32 bytes
  const padded = Buffer.alloc(32);
  bytes.copy(padded, 32 - bytes.length);
  
  // Encode to base64
  return padded.toString('base64');
}

export function buildFlowTrackingParams(
  flow: TrackedTransaction,
  chainRegistry?: ChainRegistry
): FlowTrackingParams {
  const metadata = (flow.metadata ?? {}) as Record<string, unknown>;
  const params: FlowTrackingParams = {};
  const flowType = flow.flowType;

  // Common params (for both deposit and payment flows)
  let usdcAddress = getString(metadata, 'usdcAddress');

  // If not in metadata, look up from chain registry
  if (!usdcAddress && chainRegistry) {
    // For payment flows, use destinationChain; for deposits, use initialChain
    const chainId = flowType === 'payment' ? flow.destinationChain : flow.initialChain;
    if (chainId) {
      const chainEntry = chainRegistry[chainId];
      usdcAddress = chainEntry?.contracts?.usdc;
    }
  }

  if (usdcAddress) {
    params.usdcAddress = usdcAddress;
  }

  const recipient =
    getString(metadata, 'recipient') ?? getString(metadata, 'destinationEvmAddress');
  if (recipient) {
    params.recipient = recipient;
  }

  const amountBaseUnits = getString(metadata, 'amountBaseUnits') ?? getString(metadata, 'amount');
  if (amountBaseUnits) {
    params.amountBaseUnits = amountBaseUnits;
  }

  // Extract flow-type-specific params
  if (flowType === 'deposit') {
    // Deposit flow params
  const evmBurnTxHash =
    getString(metadata, 'evmBurnTxHash') ??
    getString(metadata, 'burnTxHash') ??
    flow.txHash ??
    undefined;
  if (evmBurnTxHash) {
    params.evmBurnTxHash = evmBurnTxHash;
  }

  const forwardingAddress =
    getString(metadata, 'forwardingAddress') ?? getString(metadata, 'nobleForwardingAddress');
  if (forwardingAddress) {
    params.forwardingAddress = forwardingAddress;
  }

  const namadaReceiver =
    getString(metadata, 'namadaReceiver') ?? getString(metadata, 'destinationAddress');
  if (namadaReceiver) {
    params.namadaReceiver = namadaReceiver;
  }

  const expectedAmount =
    getString(metadata, 'expectedAmountUusdc') ??
    (amountBaseUnits
      ? amountBaseUnits.endsWith('uusdc')
        ? amountBaseUnits
        : `${amountBaseUnits}uusdc`
      : undefined);
  if (expectedAmount) {
    params.expectedAmountUusdc = expectedAmount;
  }
  } else if (flowType === 'payment') {
    // Payment flow params
    const namadaIbcTxHash =
      getString(metadata, 'namadaIbcTxHash') ?? flow.txHash ?? undefined;
  if (namadaIbcTxHash) {
    params.namadaIbcTxHash = namadaIbcTxHash;
  }

    const amount = getString(metadata, 'amount');
    if (amount) {
      params.amount = amount;
    }

  const destinationCallerB64 = getString(metadata, 'destinationCallerB64');
  if (destinationCallerB64) {
    params.destinationCallerB64 = destinationCallerB64;
  }

  const mintRecipientB64 = getString(metadata, 'mintRecipientB64');
  if (mintRecipientB64) {
    params.mintRecipientB64 = mintRecipientB64;
  }

  const channelId = getString(metadata, 'channelId');
  if (channelId) {
    params.channelId = channelId;
  }

  const destinationDomain = getNumber(metadata, 'destinationDomain');
  if (typeof destinationDomain === 'number') {
    params.destinationDomain = destinationDomain;
    }

    // Receiver is always the Noble orbiter receiver address (constant)
    // This is the address that receives IBC transfers for payment flows
    const NOBLE_ORBITER_RECEIVER = 'noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d';
    params.receiver = getString(metadata, 'receiver') ?? NOBLE_ORBITER_RECEIVER;

    // Reconstruct memoJson from CCTP parameters if not stored directly
    // This allows flows created before memoJson was stored to still work
    let memoJson = getString(metadata, 'memoJson');
    
    if (!memoJson) {
      // Try to reconstruct from available data
      let resolvedDestinationDomain = destinationDomain;
      let resolvedMintRecipientB64 = mintRecipientB64;
      
      // Get destinationDomain from chain registry if not in metadata
      if (typeof resolvedDestinationDomain !== 'number' && chainRegistry && flow.destinationChain) {
        const chainEntry = chainRegistry[flow.destinationChain];
        if (chainEntry?.cctpDomain !== undefined) {
          resolvedDestinationDomain = chainEntry.cctpDomain;
        }
      }
      
      // Calculate mintRecipientB64 from destinationAddress if not in metadata
      if (!resolvedMintRecipientB64) {
        // Try to get destinationAddress from metadata (payment flows store EVM destination address here)
        const destinationAddress =
          getString(metadata, 'destinationAddress') ??
          getString(metadata, 'destinationEvmAddress') ??
          (recipient && /^0x[0-9a-f]{40}$/i.test(recipient) ? recipient : undefined);
        
        if (destinationAddress && /^0x[0-9a-f]{40}$/i.test(destinationAddress)) {
          try {
            resolvedMintRecipientB64 = evmHex20ToBase64Bytes32(destinationAddress);
          } catch (error) {
            // Log but don't fail - we'll try other sources
            console.warn(
              `Failed to convert destinationAddress to base64: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      
      // Reconstruct memoJson if we have both destinationDomain and mintRecipientB64
      if (typeof resolvedDestinationDomain === 'number' && resolvedMintRecipientB64) {
        const memo = {
          orbiter: {
            forwarding: {
              protocol_id: 'PROTOCOL_CCTP',
              attributes: {
                '@type': '/noble.orbiter.controller.forwarding.v1.CCTPAttributes',
                destination_domain: resolvedDestinationDomain,
                mint_recipient: resolvedMintRecipientB64,
                destination_caller: destinationCallerB64 ?? null,
              },
              passthrough_payload: '',
            },
          },
        };
        memoJson = JSON.stringify(memo);
        params.memoJson = memoJson;
        // Also set the derived values in params for consistency
        if (typeof destinationDomain !== 'number') {
          params.destinationDomain = resolvedDestinationDomain;
        }
        if (!mintRecipientB64) {
          params.mintRecipientB64 = resolvedMintRecipientB64;
        }
      }
    } else {
      params.memoJson = memoJson;
    }
  }

  return params;
}

function createPendingEntry(): ChainProgressEntry {
  return {
    status: 'pending',
    stages: [],
  };
}

export function buildInitialChainProgress(
  flowType: FlowType | null | undefined,
  startBlocks: { nobleStart?: number; namadaStart?: number; evmStart?: number } = {},
  existing?: ChainProgress | null
): ChainProgress | undefined {
  if (existing) {
    return existing;
  }

  if (flowType === 'deposit') {
    return {
      noble: { ...createPendingEntry(), startBlock: startBlocks.nobleStart ?? null },
      namada: { ...createPendingEntry(), startBlock: startBlocks.namadaStart ?? null },
    };
  }

  if (flowType === 'payment') {
    return {
      namada: { ...createPendingEntry(), startBlock: startBlocks.namadaStart ?? null },
      noble: { ...createPendingEntry(), startBlock: startBlocks.nobleStart ?? null },
      evm: { ...createPendingEntry(), startBlock: startBlocks.evmStart ?? null },
    };
  }

  return undefined;
}

