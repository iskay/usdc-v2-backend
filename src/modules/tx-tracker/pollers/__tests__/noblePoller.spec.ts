import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNoblePoller } from '../noblePoller.js';
import type { TendermintRpcClient } from '../../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../../common/utils/logger.js';

describe('Noble Poller', () => {
  let mockRpcClient: TendermintRpcClient;
  let mockLogger: AppLogger;

  beforeEach(() => {
    mockRpcClient = {
      type: 'tendermint',
      getLatestBlockHeight: vi.fn(),
      getBlockResults: vi.fn(),
      getTransaction: vi.fn(),
      searchTransactions: vi.fn(),
    } as unknown as TendermintRpcClient;

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger;
  });

  it('should detect coin_received and ibc_transfer for deposit', async () => {
    const poller = createNoblePoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getLatestBlockHeight).mockResolvedValue(100);
    // Mock the nested structure that the poller expects
    const mockBlockResults = {
      result: {
        txs_results: [
          {
            code: 0,
            log: '',
            events: [
              {
                type: 'coin_received',
                attributes: [
                  { key: 'receiver', value: 'noble1forward' },
                  { key: 'amount', value: '400uusdc' },
                ],
              },
            ],
          },
        ],
        finalize_block_events: [
          {
            type: 'ibc_transfer',
            attributes: [
              { key: 'sender', value: 'noble1forward' },
              { key: 'receiver', value: 'namada1receiver' },
              { key: 'denom', value: 'uusdc' },
            ],
          },
        ],
      },
    };
    vi.mocked(mockRpcClient.getBlockResults).mockResolvedValue(
      mockBlockResults as unknown as Awaited<ReturnType<typeof mockRpcClient.getBlockResults>>
    );

    const result = await poller.pollForDeposit({
      flowId: 'test-flow',
      chain: 'noble-testnet',
      startHeight: 90,
      forwardingAddress: 'noble1forward',
      expectedAmountUusdc: '400uusdc',
      namadaReceiver: 'namada1receiver',
      timeoutMs: 1000,
      intervalMs: 100,
    });

    expect(result.receivedFound).toBe(true);
    expect(result.forwardFound).toBe(true);
    expect(result.success).toBe(true);
  });

  it('should handle timeout', async () => {
    const poller = createNoblePoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getLatestBlockHeight).mockResolvedValue(100);
    vi.mocked(mockRpcClient.getBlockResults).mockResolvedValue({
      result: {
        txs_results: [],
        finalize_block_events: [],
      },
    } as unknown as Awaited<ReturnType<typeof mockRpcClient.getBlockResults>>);

    const result = await poller.pollForDeposit({
      flowId: 'test-flow',
      chain: 'noble-testnet',
      startHeight: 90,
      forwardingAddress: 'noble1forward',
      expectedAmountUusdc: '400uusdc',
      namadaReceiver: 'namada1receiver',
      timeoutMs: 100,
      intervalMs: 50,
    });

    expect(result.receivedFound).toBe(false);
    expect(result.forwardFound).toBe(false);
  });
});

