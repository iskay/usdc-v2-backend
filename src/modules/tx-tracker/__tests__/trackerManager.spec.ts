import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrackerManager } from '../trackerManager.js';
import type { TxTrackerRepository } from '../repository.js';
import type { RpcClientFactory } from '../../../common/rpc/index.js';
import type { ChainRegistry } from '../../../config/chainRegistry.js';
import type { ChainPollingConfigs } from '../../../config/chainConfigs.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import type { TrackedTransaction } from '../types.js';

describe('Tracker Manager', () => {
  let mockRepository: TxTrackerRepository;
  let mockRpcFactory: RpcClientFactory;
  let mockChainRegistry: ChainRegistry;
  let mockChainPollingConfigs: ChainPollingConfigs;
  let mockLogger: AppLogger;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn(),
      update: vi.fn(),
      updateChainProgress: vi.fn(),
      addStatusLog: vi.fn(),
    } as unknown as TxTrackerRepository;

    mockRpcFactory = vi.fn() as unknown as RpcClientFactory;

    mockChainRegistry = {
      'sepolia-testnet': {
        id: 'sepolia-testnet',
        chainType: 'evm',
        chainId: 11155111,
        network: 'testnet',
        displayName: 'Ethereum Sepolia',
        rpcUrls: ['https://rpc.sepolia.org'],
      },
      'noble-testnet': {
        id: 'noble-testnet',
        chainType: 'tendermint',
        chainName: 'noble',
        network: 'testnet',
        displayName: 'Noble Testnet',
        rpcUrls: ['https://noble-testnet-rpc.polkachu.com'],
      },
      'namada-testnet': {
        id: 'namada-testnet',
        chainType: 'tendermint',
        chainName: 'namada',
        network: 'testnet',
        displayName: 'Namada Public Testnet',
        rpcUrls: ['https://rpc.namada.world'],
      },
    } as ChainRegistry;

    mockChainPollingConfigs = {
      'sepolia-testnet': {
        maxDurationMin: 1,
        blockWindowBackscan: 5,
        pollIntervalMs: 100,
      },
      'noble-testnet': {
        maxDurationMin: 1,
        blockWindowBackscan: 5,
        pollIntervalMs: 100,
      },
      'namada-testnet': {
        maxDurationMin: 1,
        blockWindowBackscan: 5,
        pollIntervalMs: 100,
      },
    };

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger;
  });

  it('should stop a flow', () => {
    const manager = createTrackerManager({
      repository: mockRepository,
      rpcFactory: mockRpcFactory,
      chainRegistry: mockChainRegistry,
      chainPollingConfigs: mockChainPollingConfigs,
      logger: mockLogger,
    });

    // Test that stopFlow doesn't throw when called on a non-existent flow
    expect(() => manager.stopFlow('non-existent-flow')).not.toThrow();

    // For a flow that exists, we'd need to actually start it, but that requires
    // mocking the entire RPC client chain. This test verifies the method exists
    // and doesn't throw errors.
  });

  it('should handle resume flow', async () => {
    const manager = createTrackerManager({
      repository: mockRepository,
      rpcFactory: mockRpcFactory,
      chainRegistry: mockChainRegistry,
      chainPollingConfigs: mockChainPollingConfigs,
      logger: mockLogger,
    });

    const mockFlow: TrackedTransaction = {
      id: 'test-flow',
      txHash: '0x123',
      chain: 'sepolia-testnet',
      chainType: 'evm',
      flowType: 'deposit',
      initialChain: 'sepolia-testnet',
      status: 'pending',
      chainProgress: {
        evm: {
          status: 'pending',
          txHash: '0x123',
        },
      },
      metadata: {
        evmBurnTxHash: '0x123',
        usdcAddress: '0xUSDC',
        recipient: '0xRECIPIENT',
        amountBaseUnits: '1000000',
      },
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: null,
      addressId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.mocked(mockRepository.findById).mockResolvedValue(mockFlow);

    // Resume should extract params from metadata and start tracking
    await manager.resumeFlow(mockFlow);

    // Verify that startFlow logic would be called
    expect(mockLogger.info).toHaveBeenCalled();
  });
});

