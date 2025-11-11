import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEvmPoller } from '../evmPoller.js';
import type { EvmRpcClient } from '../../../../common/rpc/evmClient.js';
import type { AppLogger } from '../../../../common/utils/logger.js';

describe('EVM Poller', () => {
  let mockRpcClient: EvmRpcClient;
  let mockLogger: AppLogger;

  beforeEach(() => {
    mockRpcClient = {
      type: 'evm',
      getBlockNumber: vi.fn(),
      getLogs: vi.fn(),
      getTransaction: vi.fn(),
      getTransactionReceipt: vi.fn(),
    } as unknown as EvmRpcClient;

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger;
  });

  it('should find USDC mint transaction', async () => {
    const poller = createEvmPoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getBlockNumber).mockResolvedValue(1000n);
    vi.mocked(mockRpcClient.getLogs).mockResolvedValue([
      {
        transactionHash: '0x123',
        blockNumber: '0x3e8',
        data: '0x' + BigInt('1000000').toString(16).padStart(64, '0'),
      },
    ]);

    const result = await poller.pollUsdcMint({
      flowId: 'test-flow',
      chain: 'sepolia-testnet',
      usdcAddress: '0xUSDC',
      recipient: '0xRECIPIENT',
      amountBaseUnits: '1000000',
      timeoutMs: 1000,
      intervalMs: 100,
    });

    expect(result.found).toBe(true);
    expect(result.txHash).toBe('0x123');
    expect(result.blockNumber).toBe(1000n);
  });

  it('should handle timeout', async () => {
    const poller = createEvmPoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getBlockNumber).mockResolvedValue(1000n);
    vi.mocked(mockRpcClient.getLogs).mockResolvedValue([]);

    const result = await poller.pollUsdcMint({
      flowId: 'test-flow',
      chain: 'sepolia-testnet',
      usdcAddress: '0xUSDC',
      recipient: '0xRECIPIENT',
      amountBaseUnits: '1000000',
      timeoutMs: 100,
      intervalMs: 50,
    });

    expect(result.found).toBe(false);
    expect(result.success).toBe(false);
  });

  it('should handle RPC errors gracefully', async () => {
    const poller = createEvmPoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getBlockNumber).mockRejectedValue(
      new Error('RPC error')
    );

    const result = await poller.pollUsdcMint({
      flowId: 'test-flow',
      chain: 'sepolia-testnet',
      usdcAddress: '0xUSDC',
      recipient: '0xRECIPIENT',
      amountBaseUnits: '1000000',
      timeoutMs: 1000,
      intervalMs: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

