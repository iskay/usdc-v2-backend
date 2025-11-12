import { describe, it, expect, vi } from 'vitest';

import type { QueueManager } from '../../../jobs/queue.js';
import type { ChainPollingConfigs } from '../../../config/chainConfigs.js';
import type { ChainRegistry } from '../../../config/chainRegistry.js';
import type { RpcClientFactory } from '../../../common/rpc/index.js';
import type {
  TendermintBlockResults,
  TendermintRpcClient,
  TendermintTx,
} from '../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import type { AddStatusLogInput, TxTrackerRepository } from '../repository.js';
import type {
  MultiChainTrackInput,
  TrackTransactionInput,
  TrackedTransaction,
} from '../types.js';
import { createTxTrackerService } from '../service.js';
import { createTrackerManager } from '../trackerManager.js';

interface StoredFlow extends TrackedTransaction {}

class InMemoryTxRepository implements TxTrackerRepository {
  private flows = new Map<string, StoredFlow>();
  statusLogs: AddStatusLogInput[] = [];

  async create(input: TrackTransactionInput): Promise<TrackedTransaction> {
    // If it's a MultiChainTrackInput (has destinationChain), use createMultiChainFlow
    if ('destinationChain' in input && input.destinationChain) {
      return this.createMultiChainFlow(input as MultiChainTrackInput);
    }
    // Otherwise, treat as single-chain transaction
    const id = `flow-${this.flows.size + 1}`;
    const now = new Date();
    const flow: StoredFlow = {
      id,
      txHash: input.txHash,
      chain: input.chain,
      chainType: input.chainType,
      flowType: input.flowType ?? null,
      initialChain: input.chain,
      destinationChain: null,
      status: input.status ?? 'pending',
      chainProgress: input.chainProgress ?? null,
      metadata: (input.metadata as Record<string, unknown>) ?? null,
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: input.errorState ?? null,
      addressId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.flows.set(id, flow);
    return flow;
  }

  async createMultiChainFlow(input: MultiChainTrackInput): Promise<TrackedTransaction> {
    const id = `flow-${this.flows.size + 1}`;
    const now = new Date();
    const flow: StoredFlow = {
      id,
      txHash: input.txHash,
      chain: input.initialChain,
      chainType: input.chainType,
      flowType: input.flowType,
      initialChain: input.initialChain,
      destinationChain: input.destinationChain,
      status: input.status ?? 'pending',
      chainProgress: input.chainProgress ?? null,
      metadata: (input.metadata as Record<string, unknown>) ?? null,
      lastCheckedAt: null,
      nextCheckAfter: null,
      errorState: input.errorState ?? null,
      addressId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.flows.set(id, flow);
    return flow;
  }

  async findById(id: string): Promise<TrackedTransaction | null> {
    const flow = this.flows.get(id);
    return flow ? { ...flow, metadata: flow.metadata ? { ...flow.metadata } : null } : null;
  }

  async findByHash(txHash: string): Promise<TrackedTransaction | null> {
    for (const flow of this.flows.values()) {
      if (flow.txHash === txHash) {
        return { ...flow, metadata: flow.metadata ? { ...flow.metadata } : null };
      }
    }
    return null;
  }

  async findUnfinishedFlows(): Promise<TrackedTransaction[]> {
    return Array.from(this.flows.values())
      .filter((flow) => flow.status !== 'completed' && flow.status !== 'failed')
      .map((flow) => ({ ...flow, metadata: flow.metadata ? { ...flow.metadata } : null }));
  }

  async update(
    id: string,
    changes: Partial<TrackedTransaction>
  ): Promise<TrackedTransaction> {
    const existing = this.flows.get(id);
    if (!existing) {
      throw new Error(`Flow ${id} not found`);
    }
    const updated: StoredFlow = {
      ...existing,
      ...changes,
      chainProgress: changes.chainProgress ?? existing.chainProgress,
      metadata: (changes.metadata as Record<string, unknown>) ?? existing.metadata,
      updatedAt: new Date(),
    };
    this.flows.set(id, updated);
    return updated;
  }

  async updateChainProgress(
    id: string,
    changes: {
      chainProgress: any;
      status?: string;
      metadata?: Record<string, unknown> | null;
      errorState?: Record<string, unknown> | null;
      nextCheckAfter?: Date | null;
    }
  ): Promise<TrackedTransaction> {
    const existing = this.flows.get(id);
    if (!existing) {
      throw new Error(`Flow ${id} not found`);
    }
    const updated: StoredFlow = {
      ...existing,
      chainProgress: changes.chainProgress,
      status: changes.status ?? existing.status,
      metadata:
        changes.metadata !== undefined ? (changes.metadata as Record<string, unknown>) : existing.metadata,
      errorState:
        changes.errorState !== undefined ? changes.errorState : existing.errorState,
      nextCheckAfter:
        changes.nextCheckAfter !== undefined ? changes.nextCheckAfter : existing.nextCheckAfter,
      updatedAt: new Date(),
    };
    this.flows.set(id, updated);
    return updated;
  }

  async addStatusLog(entry: AddStatusLogInput): Promise<void> {
    this.statusLogs.push(entry);
  }

  async getStatusLogs(transactionId: string): Promise<Array<{ id: string; transactionId: string; status: string; chain: string | null; source: string | null; detail: Record<string, unknown> | null; createdAt: Date }>> {
    return this.statusLogs
      .filter((log) => log.transactionId === transactionId)
      .map((log, index) => ({
        id: `log-${index}`,
        transactionId: log.transactionId,
        status: log.status,
        chain: log.chain ?? null,
        source: log.source ?? null,
        detail: log.detail ?? null,
        createdAt: new Date(),
      }));
  }
}

function createLogger(): AppLogger {
  const info = vi.fn((obj?: unknown, msg?: string) => {
    // eslint-disable-next-line no-console
    console.info('[info]', msg, obj);
  });
  const debug = vi.fn((obj?: unknown, msg?: string) => {
    // eslint-disable-next-line no-console
    console.debug('[debug]', msg, obj);
  });
  const warn = vi.fn((obj?: unknown, msg?: string) => {
    // eslint-disable-next-line no-console
    console.warn('[warn]', msg, obj);
  });
  const error = vi.fn((obj?: unknown, msg?: string) => {
    // eslint-disable-next-line no-console
    console.error('[error]', msg, obj);
  });

  return {
    info,
    debug,
    warn,
    error,
  } as unknown as AppLogger;
}

function buildNobleRpcClient(params: {
  coinHeight: number;
  forwardHeight: number;
  forwardingAddress: string;
  namadaReceiver: string;
  amount: string;
  latest: number;
}): TendermintRpcClient {
  const coinAttributes = [
    { key: 'receiver', value: params.forwardingAddress },
    { key: 'amount', value: params.amount },
  ];
  const forwardAttributes = [
    { key: 'sender', value: params.forwardingAddress },
    { key: 'receiver', value: params.namadaReceiver },
    { key: 'denom', value: 'uusdc' },
  ];

  const blockResults = new Map<number, TendermintBlockResults | null>([
    [
      params.coinHeight,
      {
        height: params.coinHeight.toString(),
        txs_results: [
          {
            code: 0,
            log: '',
            events: [
              {
                type: 'coin_received',
                attributes: coinAttributes,
              },
            ],
          },
        ],
      },
    ],
    [
      params.forwardHeight,
      {
        height: params.forwardHeight.toString(),
        finalize_block_events: [
          {
            type: 'ibc_transfer',
            attributes: forwardAttributes,
          },
        ],
      },
    ],
  ]);

  return {
    type: 'tendermint',
    async getLatestBlockHeight() {
      return params.latest;
    },
    async getBlockResults(height: number) {
      const result = blockResults.get(height);
      // Return empty block structure for heights without events (so poller can continue scanning)
      if (result === undefined) {
        return {
          height: height.toString(),
          txs_results: [],
          finalize_block_events: [],
        };
      }
      return result;
    },
    async getTransaction(): Promise<TendermintTx | null> {
      return null;
    },
    async searchTransactions(): Promise<TendermintTx[]> {
      return [];
    },
  };
}

function buildNamadaRpcClient(params: {
  ackHeight: number;
  forwardingAddress: string;
  namadaReceiver: string;
  amount: string;
  latest: number;
}): TendermintRpcClient {
  const packetData = JSON.stringify({
    sender: params.forwardingAddress,
    receiver: params.namadaReceiver,
    denom: 'uusdc',
    amount: params.amount,
  });

  const blockResults = new Map<number, TendermintBlockResults & { end_block_events?: Array<{ type: string; attributes?: Array<{ key: string; value: string; index?: boolean }> }> } | null>([
    [
      params.ackHeight,
      {
        height: params.ackHeight.toString(),
        finalize_block_events: undefined,
        end_block_events: [
          // inner-tx-hash is in a separate 'message' event, not in write_acknowledgement
          // This matches the actual API structure: https://rpc.testnet.siuuu.click/block_results?height=3418841
          {
            type: 'message',
            attributes: [
              { key: 'inner-tx-hash', value: 'DCAB74328D560B46CE014E5723D74B7A8440F1AC1574698AC016A9D55AF59D80' },
              { key: 'hash', value: '78B9CDB9869E0CD6D644958F8421630866ECAEB62CA2A1B7715337A1DB00D6C5' },
              { key: 'height', value: params.ackHeight.toString() },
            ],
          },
          {
            type: 'write_acknowledgement',
            attributes: [
              { key: 'packet_ack', value: '{"result":"AQ=="}' },
              { key: 'packet_data', value: packetData },
              { key: 'packet_dst_channel', value: 'channel-27' },
              { key: 'packet_dst_port', value: 'transfer' },
              { key: 'packet_sequence', value: '799' },
              { key: 'packet_src_channel', value: 'channel-639' },
              { key: 'packet_src_port', value: 'transfer' },
            ],
          },
        ],
      },
    ],
  ]);

  return {
    type: 'tendermint',
    async getLatestBlockHeight() {
      return params.latest;
    },
    async getBlockResults(height: number) {
      const result = blockResults.get(height);
      if (result !== undefined) {
        return result;
      }
      // Return empty block structure for heights without events (so poller can continue scanning)
      // Include end_block_events for Namada poller compatibility
      return {
        height: height.toString(),
        txs_results: [],
        finalize_block_events: [],
        end_block_events: [],
      } as TendermintBlockResults & { end_block_events?: Array<unknown> };
    },
    async getTransaction(): Promise<TendermintTx | null> {
      return null;
    },
    async searchTransactions(): Promise<TendermintTx[]> {
      return [];
    },
  };
}

describe('Deposit flow integration', () => {
  it('tracks a known deposit flow from creation to completion', async () => {
    const repository = new InMemoryTxRepository();
    const enqueueCalls: Array<{ data: any }> = [];

    const queueManager: QueueManager = {
      txPollingQueue: {
        add: vi.fn(async (_name: string, data: unknown) => {
          enqueueCalls.push({ data });
          return undefined;
        }),
      } as unknown as QueueManager['txPollingQueue'],
      evmPollingQueue: {} as unknown as QueueManager['evmPollingQueue'],
      noblePollingQueue: {} as unknown as QueueManager['noblePollingQueue'],
      namadaPollingQueue: {} as unknown as QueueManager['namadaPollingQueue'],
      workers: [],
      connection: {} as unknown as QueueManager['connection'],
      async close() {
        return;
      },
    };

    const chainPollingConfigs: ChainPollingConfigs = {
      'noble-testnet': {
        maxDurationMin: 5,
        blockWindowBackscan: 10,
        pollIntervalMs: 1,
      },
      'namada-testnet': {
        maxDurationMin: 5,
        blockWindowBackscan: 5,
        pollIntervalMs: 1,
      },
      'sepolia': {
        maxDurationMin: 5,
        blockWindowBackscan: 5,
        pollIntervalMs: 1,
      },
    };

    const chainRegistry = {
      sepolia: {
        id: 'sepolia',
        chainType: 'evm',
        network: 'testnet',
        displayName: 'Ethereum Sepolia',
        rpcUrls: ['https://rpc.invalid'],
      },
      'noble-testnet': {
        id: 'noble-testnet',
        chainType: 'tendermint',
        network: 'testnet',
        displayName: 'Noble Testnet',
        rpcUrls: ['https://rpc.invalid'],
      },
      'namada-testnet': {
        id: 'namada-testnet',
        chainType: 'tendermint',
        network: 'testnet',
        displayName: 'Namada Testnet',
        rpcUrls: ['https://rpc.invalid'],
      },
    } as ChainRegistry;

    const nobleClient = buildNobleRpcClient({
      coinHeight: 42569533,
      forwardHeight: 42569534,
      forwardingAddress: 'noble1cugfxuln9k2zsvey7yuaeckr7avfzffd7d44jp',
      namadaReceiver: 'tnam1qprxs9n5afscskramwajyrdjw5a64lwweudc0l78',
      amount: '100000uusdc',
      latest: 42569540,
    });

    const namadaClient = buildNamadaRpcClient({
      ackHeight: 3418841, // Actual ack block height from https://rpc.testnet.siuuu.click/block_results?height=3418841
      forwardingAddress: 'noble1cugfxuln9k2zsvey7yuaeckr7avfzffd7d44jp',
      namadaReceiver: 'tnam1qprxs9n5afscskramwajyrdjw5a64lwweudc0l78',
      amount: '100000uusdc',
      latest: 3418846, // Ensure latest is at least ack height + buffer
    });

    const rpcFactory: RpcClientFactory = (chainId: string) => {
      if (chainId === 'noble-testnet') return nobleClient;
      if (chainId === 'namada-testnet') return namadaClient;
      return {
        type: 'evm',
      } as unknown as ReturnType<RpcClientFactory>;
    };

    const logger = createLogger();

    const service = createTxTrackerService({
      repository,
      queueManager,
      logger,
      rpcFactory,
      chainPollingConfigs,
    });

    const trackerManager = createTrackerManager({
      repository,
      rpcFactory,
      chainRegistry,
      chainPollingConfigs,
      logger,
    });

    const requestPayload: MultiChainTrackInput = {
      flowType: 'deposit',
      initialChain: 'sepolia',
      destinationChain: 'namada-testnet',
      chainType: 'evm',
      txHash: '0xd8294b1c510caa839db96ca7a9992c3e53ed082b1e9467a8311a0747435d3759',
      metadata: {
        fee: '0.000000110854 ETH (~$0.0004)',
        token: 'USDC',
        total: '0.1004',
        amount: '100000',
        destinationChain: 'namada-testnet',
        destinationDomain: 4,
        destinationAddress: 'tnam1qprxs9n5afscskramwajyrdjw5a64lwweudc0l78',
        nobleForwardingAddress: 'noble1cugfxuln9k2zsvey7yuaeckr7avfzffd7d44jp',
      },
    };

    const createdFlow = await service.trackFlow(requestPayload);
    expect(createdFlow.chainProgress?.noble?.startBlock).toBeDefined();
    expect(createdFlow.chainProgress?.namada?.startBlock).toBeDefined();

    expect(queueManager.txPollingQueue.add).toHaveBeenCalledTimes(1);
    const jobPayload = enqueueCalls[0]?.data;
    expect(jobPayload).toBeDefined();

    const storedFlow = await repository.findById(createdFlow.id);
    expect(storedFlow).not.toBeNull();

    await trackerManager.startFlow(storedFlow as TrackedTransaction, jobPayload.params);

    const finalFlow = await repository.findById(createdFlow.id);
    expect(finalFlow?.status).toBe('completed');
    expect(finalFlow?.chainProgress?.noble?.status).toBe('confirmed');
    expect(finalFlow?.chainProgress?.namada?.status).toBe('confirmed');
    expect(repository.statusLogs.some((log) => log.status === 'noble_cctp_minted')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'noble_ibc_forwarded')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'namada_received')).toBe(true);
  }, 5 * 60 * 1000); // 5 minutes timeout for polling

  it('tracks a known successful Noble→Namada deposit using real block 42569565', async () => {
    // This test simulates receiving a request from the frontend to track a known successful tx
    // Real block data from: https://noble-testnet-rpc.polkachu.com/block_results?height=42569565
    const actualBlockHeight = 42569565;
    const forwardingAddress = 'noble1cugfxuln9k2zsvey7yuaeckr7avfzffd7d44jp';
    const namadaReceiver = 'tnam1qprxs9n5afscskramwajyrdjw5a64lwweudc0l78';
    const expectedAmount = '100000uusdc';
    const txHash = '0xd8294b1c510caa839db96ca7a9992c3e53ed082b1e9467a8311a0747435d3759';

    // Actual block response structure matching the real API response
    const actualBlockResponse: TendermintBlockResults = {
      height: actualBlockHeight.toString(),
      txs_results: [
        {
          code: 0,
          log: '',
          events: [
            {
              type: 'coin_received',
              attributes: [
                { key: 'receiver', value: 'noble1x74lhe0pqqv7rcg4pc4svtxhm9hnf79pxpfqfv', index: true },
                { key: 'amount', value: '100000uusdc', index: true },
                { key: 'msg_index', value: '0', index: true },
              ],
            },
            {
              type: 'coin_received',
              attributes: [
                { key: 'receiver', value: forwardingAddress, index: true },
                { key: 'amount', value: expectedAmount, index: true },
                { key: 'msg_index', value: '0', index: true },
              ],
            },
          ],
        },
      ],
      finalize_block_events: [
        {
          type: 'ibc_transfer',
          attributes: [
            { key: 'sender', value: forwardingAddress, index: true },
            { key: 'receiver', value: namadaReceiver, index: true },
            { key: 'amount', value: '100000', index: true },
            { key: 'denom', value: 'uusdc', index: true },
            { key: 'memo', value: '', index: true },
            { key: 'mode', value: 'EndBlock', index: true },
          ],
        },
      ],
    };

    const repository = new InMemoryTxRepository();
    const logger = createLogger();

    // Create RPC client factory that returns the real block data at the correct height
    const nobleRpcClient: TendermintRpcClient = {
      type: 'tendermint',
      async getLatestBlockHeight() {
        return actualBlockHeight + 10;
      },
      async getBlockResults(height: number) {
        if (height === actualBlockHeight) {
          logger.debug(
            { height, hasTxs: actualBlockResponse.txs_results?.length ?? 0, hasFinalizeEvents: actualBlockResponse.finalize_block_events?.length ?? 0 },
            'Returning actual block data for height'
          );
          return actualBlockResponse;
        }
        // Return empty block structure for other heights (so poller can continue scanning)
        logger.debug({ height }, 'Returning empty block for height');
        return {
          height: height.toString(),
          txs_results: [],
          finalize_block_events: [],
        };
      },
      async getTransaction(): Promise<TendermintTx | null> {
        return null;
      },
      async searchTransactions(): Promise<TendermintTx[]> {
        return [];
      },
    };

    // Actual ack block height from https://rpc.testnet.siuuu.click/block_results?height=3418841
    const namadaAckHeight = 3418841;
    const namadaClient = buildNamadaRpcClient({
      ackHeight: namadaAckHeight,
      forwardingAddress,
      namadaReceiver,
      amount: expectedAmount,
      latest: namadaAckHeight + 5, // Ensure latest is at least the ack height + buffer
    });

    const rpcFactory: RpcClientFactory = (chainId: string) => {
      if (chainId === 'noble-testnet') {
        return nobleRpcClient;
      }
      if (chainId === 'namada-testnet') {
        return namadaClient;
      }
      return {
        type: 'evm',
      } as unknown as ReturnType<RpcClientFactory>;
    };

    const chainPollingConfigs: ChainPollingConfigs = {
      'noble-testnet': {
        maxDurationMin: 5,
        blockWindowBackscan: 10,
        pollIntervalMs: 1,
      },
      'namada-testnet': {
        maxDurationMin: 5,
        blockWindowBackscan: 5,
        pollIntervalMs: 1,
      },
      'sepolia': {
        maxDurationMin: 5,
        blockWindowBackscan: 5,
        pollIntervalMs: 1,
      },
    };

    const chainRegistry = {
      sepolia: {
        id: 'sepolia',
        chainType: 'evm',
        network: 'testnet',
        displayName: 'Ethereum Sepolia',
        rpcUrls: ['https://rpc.invalid'],
      },
      'noble-testnet': {
        id: 'noble-testnet',
        chainType: 'tendermint',
        network: 'testnet',
        displayName: 'Noble Testnet',
        rpcUrls: ['https://noble-testnet-rpc.polkachu.com'],
      },
      'namada-testnet': {
        id: 'namada-testnet',
        chainType: 'tendermint',
        network: 'testnet',
        displayName: 'Namada Testnet',
        rpcUrls: ['https://rpc.namada.world'],
      },
    } as ChainRegistry;

    const trackerManager = createTrackerManager({
      repository,
      rpcFactory,
      chainRegistry,
      chainPollingConfigs,
      logger,
    });

    // Step 1: Simulate frontend request to track a tx flow
    logger.info({ txHash, forwardingAddress, namadaReceiver }, 'Simulating frontend request to track deposit flow');

    // Create flow with proper chain progress initialization (simulating what the service does)
    const flow = await repository.createMultiChainFlow({
      txHash,
      chainType: 'evm',
      flowType: 'deposit',
      initialChain: 'sepolia',
      destinationChain: 'namada-testnet',
      chainProgress: {
        noble: {
          status: 'pending',
          startBlock: actualBlockHeight - 10, // Start scanning a bit before the actual block
        },
        namada: {
          status: 'pending',
          startBlock: namadaAckHeight - 10, // Start scanning well before the ack block (3418841)
        },
      },
      metadata: {
        forwardingAddress,
        namadaReceiver,
        expectedAmountUusdc: expectedAmount,
      },
    });

    logger.info({ flowId: flow.id, startBlocks: flow.chainProgress }, 'Created flow, starting polling');

    // Step 2: Begin polling to track the tx (simulating what the job processor does)
    const params = {
      forwardingAddress,
      namadaReceiver,
      expectedAmountUusdc: expectedAmount,
    };

    await trackerManager.startFlow(flow, params);

    // Step 3: Verify the flow progressed through all stages to Success
    const finalFlow = await repository.findById(flow.id);
    expect(finalFlow).not.toBeNull();
    expect(finalFlow?.status).toBe('completed');
    expect(finalFlow?.chainProgress?.noble?.status).toBe('confirmed');
    expect(finalFlow?.chainProgress?.namada?.status).toBe('confirmed');

    // Verify status logs were created
    expect(repository.statusLogs.some((log) => log.status === 'noble_cctp_minted')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'noble_ibc_forwarded')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'namada_received')).toBe(true);

    // Verify detailed logging occurred
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: flow.id,
        height: actualBlockHeight,
      }),
      'Noble coin_received matched'
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: flow.id,
        height: actualBlockHeight,
      }),
      'Noble ibc_transfer matched'
    );

    logger.info({ flowId: flow.id, finalStatus: finalFlow?.status }, 'Test completed successfully');
  }, 5 * 60 * 1000); // 5 minutes timeout for polling
});

