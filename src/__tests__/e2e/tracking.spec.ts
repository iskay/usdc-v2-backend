import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackedTransaction } from '../../modules/tx-tracker/types.js';

describe('E2E Transaction Tracking', () => {
  beforeEach(() => {
    // Reset mocks between tests
    vi.clearAllMocks();
  });

  it('should handle deposit flow structure', () => {
    // This is a structural test to verify the flow data model
    const depositFlow: TrackedTransaction = {
      id: 'test-flow-id',
      txHash: '0xevmtxhash',
      chain: 'sepolia-testnet',
      chainType: 'evm',
      flowType: 'deposit',
      initialChain: 'sepolia-testnet',
      status: 'pending',
      chainProgress: {
        evm: {
          status: 'pending',
          txHash: '0xevmtxhash',
          startBlock: 1000,
        },
        noble: {
          status: 'pending',
        },
        namada: {
          status: 'pending',
        },
      },
      metadata: {
        evmBurnTxHash: '0xevmtxhash',
        usdcAddress: '0xUSDC',
        recipient: '0xRECIPIENT',
        amountBaseUnits: '1000000',
        forwardingAddress: 'noble1forward',
        namadaReceiver: 'namada1receiver',
        expectedAmountUusdc: '400uusdc',
      },
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: null,
      addressId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(depositFlow.flowType).toBe('deposit');
    expect(depositFlow.chainProgress?.evm).toBeDefined();
    expect(depositFlow.chainProgress?.noble).toBeDefined();
    expect(depositFlow.chainProgress?.namada).toBeDefined();
  });

  it('should handle payment flow structure', () => {
    const paymentFlow: TrackedTransaction = {
      id: 'test-payment-flow',
      txHash: '0xnamadatx',
      chain: 'namada-testnet',
      chainType: 'tendermint',
      flowType: 'payment',
      initialChain: 'namada-testnet',
      status: 'pending',
      chainProgress: {
        namada: {
          status: 'pending',
          txHash: '0xnamadatx',
        },
        noble: {
          status: 'pending',
        },
        evm: {
          status: 'pending',
        },
      },
      metadata: {
        namadaIbcTxHash: '0xnamadatx',
        memoJson: '{"test": "memo"}',
        receiver: 'noble1receiver',
        amount: '400uusdc',
      },
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: null,
      addressId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(paymentFlow.flowType).toBe('payment');
    expect(paymentFlow.chainProgress?.namada).toBeDefined();
    expect(paymentFlow.chainProgress?.noble).toBeDefined();
    expect(paymentFlow.chainProgress?.evm).toBeDefined();
  });

  it('should support gasless stages in chain progress', () => {
    const flowWithGasless: TrackedTransaction = {
      id: 'test-gasless-flow',
      txHash: '0xevmtxhash',
      chain: 'sepolia-testnet',
      chainType: 'evm',
      flowType: 'deposit',
      initialChain: 'sepolia-testnet',
      status: 'pending',
      chainProgress: {
        evm: {
          status: 'pending',
          gaslessStages: [
            {
              stage: 'gasless_quote_pending',
              status: 'pending',
              source: 'client',
              occurredAt: new Date().toISOString(),
            },
            {
              stage: 'gasless_quote_received',
              status: 'confirmed',
              source: 'client',
              occurredAt: new Date().toISOString(),
            },
          ],
        },
      },
      metadata: null,
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: null,
      addressId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(flowWithGasless.chainProgress?.evm?.gaslessStages).toBeDefined();
    expect(flowWithGasless.chainProgress?.evm?.gaslessStages?.length).toBe(2);
    expect(flowWithGasless.chainProgress?.evm?.gaslessStages?.[0]?.source).toBe('client');
  });
});

