import type { FlowTrackingParams } from './trackerManager.js';
import type { ChainProgress, ChainProgressEntry, FlowType, TrackedTransaction } from './types.js';

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

export function buildFlowTrackingParams(flow: TrackedTransaction): FlowTrackingParams {
  const metadata = (flow.metadata ?? {}) as Record<string, unknown>;
  const params: FlowTrackingParams = {};

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

  const usdcAddress = getString(metadata, 'usdcAddress');
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

  const memoJson = getString(metadata, 'memoJson');
  if (memoJson) {
    params.memoJson = memoJson;
  }

  const namadaIbcTxHash = getString(metadata, 'namadaIbcTxHash');
  if (namadaIbcTxHash) {
    params.namadaIbcTxHash = namadaIbcTxHash;
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

