import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNamadaPoller } from '../namadaPoller.js';
import type { TendermintRpcClient } from '../../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../../common/utils/logger.js';

describe('Namada Poller', () => {
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

  it('should detect write_acknowledgement for deposit', async () => {
    const poller = createNamadaPoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getLatestBlockHeight).mockResolvedValue(100);
    vi.mocked(mockRpcClient.getBlockResults).mockResolvedValue({
      result: {
        end_block_events: [
          {
            type: 'write_acknowledgement',
            attributes: [
              { key: 'packet_ack', value: '{"result":"AQ=="}' },
              {
                key: 'packet_data',
                value: JSON.stringify({
                  receiver: 'namada1receiver',
                  sender: 'noble1forward',
                  denom: 'uusdc',
                  amount: '400',
                }),
              },
              { key: 'inner-tx-hash', value: '0xnamadatx' },
            ],
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof mockRpcClient.getBlockResults>>);

    const result = await poller.pollForDeposit({
      flowId: 'test-flow',
      chain: 'namada-testnet',
      startHeight: 90,
      forwardingAddress: 'noble1forward',
      namadaReceiver: 'namada1receiver',
      expectedAmountUusdc: '400uusdc',
      timeoutMs: 1000,
      intervalMs: 100,
    });

    expect(result.found).toBe(true);
    expect(result.ackFound).toBe(true);
    expect(result.namadaTxHash).toBe('0xnamadatx');
  });

  it('should handle timeout', async () => {
    const poller = createNamadaPoller(mockRpcClient, mockLogger);

    vi.mocked(mockRpcClient.getLatestBlockHeight).mockResolvedValue(100);
    vi.mocked(mockRpcClient.getBlockResults).mockResolvedValue({
      result: {
        end_block_events: [],
      },
    } as unknown as Awaited<ReturnType<typeof mockRpcClient.getBlockResults>>);

    const result = await poller.pollForDeposit({
      flowId: 'test-flow',
      chain: 'namada-testnet',
      startHeight: 90,
      forwardingAddress: 'noble1forward',
      namadaReceiver: 'namada1receiver',
      expectedAmountUusdc: '400uusdc',
      timeoutMs: 100,
      intervalMs: 50,
    });

    expect(result.found).toBe(false);
    expect(result.ackFound).toBe(false);
  });
});

