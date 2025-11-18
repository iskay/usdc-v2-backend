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
import type { EvmRpcClient, EvmLog } from '../../../common/rpc/evmClient.js';
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

function buildNamadaRpcClientForPayment(params: {
  txHash: string;
  txHeight: number;
  latest: number;
}): TendermintRpcClient {
  const blockResults = new Map<number, TendermintBlockResults | null>([]);

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
    async getTransaction(txHash: string): Promise<TendermintTx | null> {
      if (txHash === params.txHash) {
        return {
          hash: params.txHash,
          height: params.txHeight.toString(),
          tx: '',
          result: {
            code: 0,
            log: '',
          },
        };
      }
      return null;
    },
    async searchTransactions(): Promise<TendermintTx[]> {
      return [];
    },
  };
}

function buildNobleRpcClientForPayment(params: {
  ackHeight: number;
  cctpHeight: number;
  memoJson: string;
  receiver: string;
  amount: string;
  destinationCallerB64: string | null;
  mintRecipientB64: string;
  destinationDomain: number;
  latest: number;
}): TendermintRpcClient {
  // packet_data should contain receiver, amount, and memo as separate fields
  // The memo field should be the JSON string directly (not double-encoded)
  const packetData = JSON.stringify({
    receiver: params.receiver,
    amount: params.amount,
    memo: params.memoJson, // memoJson is already a JSON string
  });

  // Build block results - handle case where both events are in the same block
  const blockResults = new Map<number, TendermintBlockResults | null>();
  
  const ackEvent = {
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
  };

  const cctpEvent = {
    type: 'circle.cctp.v1.DepositForBurn',
    attributes: [
      { key: 'amount', value: `"${params.amount}"` },
      // Include destination_caller (empty string when null, as the poller expects)
      { key: 'destination_caller', value: `"${params.destinationCallerB64 ?? ''}"` },
      { key: 'mint_recipient', value: `"${params.mintRecipientB64}"` },
      { key: 'destination_domain', value: params.destinationDomain.toString() },
    ],
  };

  // If both events are in the same block, combine them
  if (params.ackHeight === params.cctpHeight) {
    blockResults.set(params.ackHeight, {
      height: params.ackHeight.toString(),
      txs_results: [
        {
          code: 0,
          log: '',
          events: [ackEvent, cctpEvent],
        },
      ],
      finalize_block_events: [],
    });
  } else {
    // Separate blocks
    blockResults.set(params.ackHeight, {
      height: params.ackHeight.toString(),
      txs_results: [
        {
          code: 0,
          log: '',
          events: [ackEvent],
        },
      ],
      finalize_block_events: [],
    });
    blockResults.set(params.cctpHeight, {
      height: params.cctpHeight.toString(),
      txs_results: [
        {
          code: 0,
          log: '',
          events: [cctpEvent],
        },
      ],
      finalize_block_events: [],
    });
  }

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

function buildEvmRpcClient(params: {
  mintBlock: number;
  usdcAddress: string;
  recipient: string;
  amountBaseUnits: string;
  latest: number;
}): EvmRpcClient {
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  function toPaddedTopicAddress(addr: string): string {
    const clean = addr.toLowerCase().replace(/^0x/, '');
    return `0x${clean.padStart(64, '0')}`;
  }

  // Generate a deterministic but realistic transaction hash from the block and recipient
  // This creates a hash-like string that's deterministic for testing
  const txHashInput = `${params.mintBlock}-${params.recipient}-${params.amountBaseUnits}`;
  const txHashBytes = Buffer.from(txHashInput).toString('hex').padEnd(64, '0').slice(0, 64);
  const transactionHash = `0x${txHashBytes}`;

  const mintLog: EvmLog = {
    address: params.usdcAddress,
    topics: [
      TRANSFER_TOPIC,
      toPaddedTopicAddress(ZERO_ADDRESS),
      toPaddedTopicAddress(params.recipient),
    ],
    data: `0x${BigInt(params.amountBaseUnits).toString(16).padStart(64, '0')}`,
    blockNumber: `0x${params.mintBlock.toString(16)}`,
    transactionHash,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };

  return {
    type: 'evm',
    async getBlockNumber(): Promise<number> {
      return params.latest;
    },
    async getLogs(filter: {
      fromBlock?: string;
      toBlock?: string;
      address?: string | string[];
      topics?: (string | string[] | null)[];
    }): Promise<EvmLog[]> {
      const fromBlock = filter.fromBlock ? parseInt(filter.fromBlock, 16) : 0;
      const toBlock = filter.toBlock ? parseInt(filter.toBlock, 16) : params.latest;

      // Check if this log matches the filter
      if (
        filter.address === params.usdcAddress &&
        filter.topics &&
        filter.topics[0] === TRANSFER_TOPIC &&
        filter.topics[1] === toPaddedTopicAddress(ZERO_ADDRESS) &&
        filter.topics[2] === toPaddedTopicAddress(params.recipient) &&
        params.mintBlock >= fromBlock &&
        params.mintBlock <= toBlock
      ) {
        return [mintLog];
      }

      return [];
    },
    async getTransaction(): Promise<null> {
      return null;
    },
    async getTransactionReceipt(): Promise<null> {
      return null;
    },
  };
}

describe('Payment flow integration', () => {
  it('tracks a known payment flow from creation to completion', async () => {
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

    // Test data from the provided transaction
    const namadaTxHash = '85B9ED9024EB15067CE43D16C36D80C67D6B209E2E062D33C08BF79698E77A3E';
    const namadaTxHeight = 3471233;
    const namadaStartBlock = 3471233;
    // Noble block heights - both events occur in the same block
    // Real block: https://noble-testnet-rpc.polkachu.com/block_results?height=42913153
    const nobleEventHeight = 42913153; // Both ack and CCTP events are in this block
    const nobleLatest = nobleEventHeight + 20; // Ensure latest is well after events (like deposit test)
    const evmMintBlock = 6000000;
    const amount = '100000';
    const destinationAddress = '0x9dcadbfa2bca34faa28840c4fc391fc421a57921';
    const usdcAddress = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // Sepolia USDC address

    // Real values from the actual transaction
    const memoJson = JSON.stringify({
      orbiter: {
        forwarding: {
          protocol_id: 'PROTOCOL_CCTP',
          attributes: {
            '@type': '/noble.orbiter.controller.forwarding.v1.CCTPAttributes',
            destination_domain: 0,
            mint_recipient: 'AAAAAAAAAAAAAAAAncrb+ivKNPqiiEDE/DkfxCGleSE=',
            destination_caller: null,
          },
          passthrough_payload: '',
        },
      },
    });
    const receiver = 'noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d'; // Noble orbiter receiver address
    const destinationCallerB64 = null; // null as per the memo
    const mintRecipientB64 = 'AAAAAAAAAAAAAAAAncrb+ivKNPqiiEDE/DkfxCGleSE='; // From the memo
    const destinationDomain = 0; // From the memo

    const namadaClient = buildNamadaRpcClientForPayment({
      txHash: namadaTxHash,
      txHeight: namadaTxHeight,
      latest: namadaTxHeight + 10,
    });

    const nobleClient = buildNobleRpcClientForPayment({
      ackHeight: nobleEventHeight,
      cctpHeight: nobleEventHeight, // Both events are in the same block
      memoJson,
      receiver,
      amount,
      destinationCallerB64,
      mintRecipientB64,
      destinationDomain,
      latest: nobleLatest,
    });

    const evmClient = buildEvmRpcClient({
      mintBlock: evmMintBlock,
      usdcAddress,
      recipient: destinationAddress,
      amountBaseUnits: amount,
      latest: evmMintBlock + 10,
    });

    const rpcFactory: RpcClientFactory = (chainId: string) => {
      if (chainId === 'noble-testnet') return nobleClient;
      if (chainId === 'namada-testnet') return namadaClient;
      if (chainId === 'sepolia') return evmClient;
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
      service,
      rpcFactory,
      chainRegistry,
      chainPollingConfigs,
      logger,
    });

    const requestPayload: MultiChainTrackInput = {
      flowType: 'payment',
      initialChain: 'namada-testnet',
      destinationChain: 'sepolia',
      chainType: 'tendermint',
      txHash: namadaTxHash,
      chainProgress: {
        namada: {
          status: 'pending',
          stages: [],
          startBlock: namadaStartBlock,
        },
        noble: {
          status: 'pending',
          stages: [],
          startBlock: nobleEventHeight - 10, // Start scanning before the event block
        },
        evm: {
          status: 'pending',
          stages: [],
          startBlock: evmMintBlock - 10, // Start scanning before the mint block
        },
      },
      metadata: {
        fee: '$0.08',
        token: 'USDC',
        total: '0.18',
        amount: amount,
        localId: '64284151-9fa8-4cdf-8af2-29ff4c0eba08',
        destinationChain: 'Sepolia',
        destinationAddress: destinationAddress,
        namadaIbcTxHash: namadaTxHash,
        memoJson: memoJson,
        receiver: receiver,
        amountBaseUnits: amount,
        destinationCallerB64: destinationCallerB64,
        mintRecipientB64: mintRecipientB64,
        destinationDomain: destinationDomain,
        usdcAddress: usdcAddress,
      },
    };

    const createdFlow = await service.trackFlow(requestPayload);
    expect(createdFlow.chainProgress?.noble?.startBlock).toBeDefined();
    expect(createdFlow.chainProgress?.namada?.startBlock).toBeDefined();
    expect(createdFlow.chainProgress?.evm?.startBlock).toBeDefined();

    expect(queueManager.txPollingQueue.add).toHaveBeenCalledTimes(1);
    const jobPayload = enqueueCalls[0]?.data;
    expect(jobPayload).toBeDefined();

    const storedFlow = await repository.findById(createdFlow.id);
    expect(storedFlow).not.toBeNull();

    await trackerManager.startFlow(storedFlow as TrackedTransaction, jobPayload.params);

    const finalFlow = await repository.findById(createdFlow.id);
    expect(finalFlow?.status).toBe('completed');
    expect(finalFlow?.chainProgress?.namada?.status).toBe('confirmed');
    expect(finalFlow?.chainProgress?.noble?.status).toBe('confirmed');
    expect(finalFlow?.chainProgress?.evm?.status).toBe('confirmed');
    expect(repository.statusLogs.some((log) => log.status === 'namada_ibc_sent')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'noble_received')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'noble_cctp_burned')).toBe(true);
    expect(repository.statusLogs.some((log) => log.status === 'evm_mint_confirmed')).toBe(true);
  }, 5 * 60 * 1000); // 5 minutes timeout for polling
});

