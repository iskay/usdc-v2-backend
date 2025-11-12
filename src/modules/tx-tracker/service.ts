import { Prisma } from '@prisma/client';

import type { AppLogger } from '../../common/utils/logger.js';
import { buildFlowTrackingParams, buildInitialChainProgress } from './params.js';
import type { AddStatusLogInput, StatusLogEntry, TxTrackerRepository } from './repository.js';
import type { FlowTrackingParams } from './trackerManager.js';
import type { QueueManager } from '../../jobs/queue.js';
import type { RpcClientFactory } from '../../common/rpc/index.js';
import type { TendermintRpcClient } from '../../common/rpc/tendermintClient.js';
import { getChainPollingConfig, type ChainPollingConfigs } from '../../config/chainConfigs.js';
import type {
  ChainProgress,
  ChainStage,
  FlowType,
  MultiChainTrackInput,
  StatusSource,
  TrackTransactionInput,
  TrackedTransaction
} from './types.js';

export interface ClientStageUpdate {
  flowId: string;
  chain: keyof ChainProgress;
  stage: string;
  status?: ChainStage['status'];
  message?: string;
  txHash?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  kind?: 'gasless' | 'default';
  source?: StatusSource;
}

export interface TxTrackerService {
  track(input: TrackTransactionInput): Promise<TrackedTransaction>;
  trackFlow(input: MultiChainTrackInput): Promise<TrackedTransaction>;
  getByHash(txHash: string): Promise<TrackedTransaction | null>;
  getById(id: string): Promise<TrackedTransaction | null>;
  listUnfinishedFlows(): Promise<TrackedTransaction[]>;
  appendClientStage(update: ClientStageUpdate): Promise<void>;
  getStatusLogs(flowId: string): Promise<StatusLogEntry[]>;
}

export interface TxTrackerServiceDependencies {
  repository: TxTrackerRepository;
  queueManager: QueueManager;
  logger: AppLogger;
  rpcFactory: RpcClientFactory;
  chainPollingConfigs: ChainPollingConfigs;
}

const CLIENT_SOURCE: StatusSource = 'client';

export function createTxTrackerService({
  repository,
  queueManager,
  logger,
  rpcFactory,
  chainPollingConfigs,
}: TxTrackerServiceDependencies): TxTrackerService {
  async function ensureUnique(input: TrackTransactionInput): Promise<TrackedTransaction> {
    const existing = await repository.findByHash(input.txHash);
    if (existing) {
      return existing;
    }

    try {
      const created = await repository.create(input);
      logger.debug({ txHash: created.txHash }, 'Tracked transaction created');
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const conflict = await repository.findByHash(input.txHash);
        if (conflict) {
          return conflict;
        }
      }

      logger.error({ err: error, txHash: input.txHash }, 'Failed to track transaction');
      throw error;
    }
  }

  return {
    async track(input) {
      return ensureUnique(input);
    },

    async trackFlow(input) {
      const { txHash } = input;
      if (txHash) {
        const existing = await repository.findByHash(txHash);
        if (existing) {
          return existing;
        }
      }

      const startBlocks =
        input.flowType != null
          ? await resolveStartBlocks(
              input.flowType,
              input.destinationChain,
              rpcFactory,
              chainPollingConfigs,
              logger
            )
          : {};

      const chainProgress = buildInitialChainProgress(
        input.flowType ?? null,
        startBlocks,
        input.chainProgress
      );

      const created = await repository.createMultiChainFlow({
        ...input,
        chainProgress,
      });
      logger.debug(
        { flowId: created.id, flowType: created.flowType, initialChain: created.initialChain },
        'Created multi-chain flow'
      );

      // Extract tracking params from created flow metadata
      const params: FlowTrackingParams = buildFlowTrackingParams(created);
      logger.debug({ flowId: created.id, params }, 'Derived tracking parameters for flow');
      
      // Enqueue polling job
      await queueManager.txPollingQueue.add(
        `flow-${created.id}`,
        {
          flowId: created.id,
          flowType: created.flowType || 'deposit',
          params,
        },
        {
          jobId: `flow-${created.id}-${Date.now()}`,
        }
      );

      logger.debug({ flowId: created.id }, 'Enqueued polling job for flow');

      return created;
    },

    async getByHash(txHash) {
      return repository.findByHash(txHash);
    },

    async getById(id) {
      return repository.findById(id);
    },

    async listUnfinishedFlows() {
      return repository.findUnfinishedFlows();
    },

    async appendClientStage(update) {
      const transaction = await repository.findById(update.flowId);
      if (!transaction) {
        throw new Error(`Flow ${update.flowId} not found`);
      }

      const chainProgress = cloneChainProgress(transaction.chainProgress ?? {});
      const chainEntry = chainProgress[update.chain] ?? {};

      const stage: ChainStage = {
        stage: update.stage,
        status: update.status ?? 'pending',
        message: update.message,
        txHash: update.txHash,
        occurredAt: (update.occurredAt ?? new Date()).toISOString(),
        metadata: update.metadata,
        source: update.source ?? CLIENT_SOURCE
      };

      if (update.kind === 'gasless') {
        const gaslessStages = Array.isArray(chainEntry.gaslessStages)
          ? [...chainEntry.gaslessStages]
          : [];
        gaslessStages.push(stage);
        chainEntry.gaslessStages = gaslessStages;
      } else {
        const stages = Array.isArray(chainEntry.stages) ? [...chainEntry.stages] : [];
        stages.push(stage);
        chainEntry.stages = stages;
      }

      chainProgress[update.chain] = {
        ...chainEntry,
        status: update.status ?? chainEntry.status,
        txHash: update.txHash ?? chainEntry.txHash,
        lastCheckedAt: new Date()
      };

      await repository.updateChainProgress(update.flowId, {
        chainProgress,
        status: determineOverallStatus(transaction.flowType ?? undefined, chainProgress),
        metadata: transaction.metadata,
        errorState: transaction.errorState
      });

      await repository.addStatusLog(createStatusLogPayload(update, CLIENT_SOURCE));

      logger.debug(
        { flowId: update.flowId, stage: update.stage, chain: update.chain },
        'Appended client stage to flow'
      );
    },

    async getStatusLogs(flowId) {
      return repository.getStatusLogs(flowId);
    }
  };
}

function cloneChainProgress(progress: ChainProgress): ChainProgress {
  return {
    evm: progress.evm ? { ...progress.evm, stages: [...(progress.evm.stages ?? [])], gaslessStages: [...(progress.evm.gaslessStages ?? [])] } : undefined,
    noble: progress.noble ? { ...progress.noble, stages: [...(progress.noble.stages ?? [])] } : undefined,
    namada: progress.namada ? { ...progress.namada, stages: [...(progress.namada.stages ?? [])] } : undefined
  };
}

function determineOverallStatus(flowType: FlowType | undefined, progress: ChainProgress): string {
  const chains: Array<keyof ChainProgress> = flowType === 'payment'
    ? ['namada', 'noble', 'evm']
    : ['evm', 'noble', 'namada'];

  for (const chain of chains) {
    const entry = progress[chain];
    if (!entry) {
      return 'pending';
    }
    if (entry.stages?.some((stage) => stage.status === 'failed')) {
      return 'failed';
    }
  }

  const finalEntry = progress[chains[chains.length - 1]];
  const lastStage = finalEntry?.stages?.[finalEntry.stages.length - 1];
  if (lastStage?.stage === 'completed' || lastStage?.status === 'confirmed') {
    return 'completed';
  }

  return 'pending';
}

function createStatusLogPayload(update: ClientStageUpdate, defaultSource: StatusSource): AddStatusLogInput {
  return {
    transactionId: update.flowId,
    status: update.stage,
    chain: update.chain,
    source: update.source ?? defaultSource,
    detail: {
      status: update.status ?? 'pending',
      message: update.message,
      txHash: update.txHash,
      occurredAt: (update.occurredAt ?? new Date()).toISOString(),
      metadata: update.metadata,
      kind: update.kind ?? 'default'
    }
  };
}

async function resolveStartBlocks(
  flowType: FlowType,
  destinationChain: string | null | undefined,
  rpcFactory: RpcClientFactory,
  chainPollingConfigs: ChainPollingConfigs,
  logger: AppLogger
): Promise<{ nobleStart?: number; namadaStart?: number; evmStart?: number }> {
  const result: { nobleStart?: number; namadaStart?: number; evmStart?: number } = {};

  async function compute(chainId: string | undefined): Promise<number | undefined> {
    if (!chainId) return undefined;
    try {
      const client = rpcFactory(chainId);
      if (!('getLatestBlockHeight' in client)) {
        return undefined;
      }
      const tendermintClient = client as TendermintRpcClient;
      const config = getChainPollingConfig(chainPollingConfigs, chainId);
      const latest = await tendermintClient.getLatestBlockHeight();
      const start = Math.max(0, latest - config.blockWindowBackscan);
      logger.debug({ chain: chainId, latest, start }, 'Computed start block for flow');
      return start;
    } catch (error) {
      logger.warn({ err: error, chain: chainId }, 'Failed to compute start block for chain');
      return undefined;
    }
  }

  if (flowType === 'deposit') {
    result.nobleStart = await compute('noble-testnet');
    const namadaChain = destinationChain ?? 'namada-testnet';
    result.namadaStart = await compute(namadaChain);
  } else if (flowType === 'payment') {
    result.namadaStart = await compute('namada-testnet');
    result.nobleStart = await compute('noble-testnet');
    // EVM polling start block not required yet; placeholder for future extension
  }

  return result;
}
