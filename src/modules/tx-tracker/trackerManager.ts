import type { ChainRegistry } from '../../config/chainRegistry.js';
import type { ChainPollingConfigs, ChainPollingConfig } from '../../config/chainConfigs.js';
import { getChainPollingConfig } from '../../config/chainConfigs.js';
import type { AppLogger } from '../../common/utils/logger.js';
import type { RpcClientFactory } from '../../common/rpc/index.js';
import type { EvmRpcClient } from '../../common/rpc/evmClient.js';
import type { TendermintRpcClient } from '../../common/rpc/tendermintClient.js';
import { createEvmPoller } from './pollers/evmPoller.js';
import { createNoblePoller } from './pollers/noblePoller.js';
import { createNamadaPoller } from './pollers/namadaPoller.js';
import type { TxTrackerRepository } from './repository.js';
import { getFlowStatusEmitter, type FlowStatusEventEmitter } from './events.js';
import type {
  ChainProgress,
  ChainProgressEntry,
  TrackedTransaction,
  TxStatusUpdate,
} from './types.js';
import type { TendermintRpcClient } from '../../common/rpc/tendermintClient.js';

export interface TrackerManager {
  startFlow(
    flow: TrackedTransaction,
    params: FlowTrackingParams
  ): Promise<void>;
  resumeFlow(flow: TrackedTransaction): Promise<void>;
  stopFlow(flowId: string): void;
}

export interface FlowTrackingParams {
  // Deposit flow params
  evmBurnTxHash?: string;
  usdcAddress?: string;
  recipient?: string;
  amountBaseUnits?: string;
  forwardingAddress?: string;
  namadaReceiver?: string;
  expectedAmountUusdc?: string;

  // Payment flow params
  namadaIbcTxHash?: string;
  memoJson?: string;
  receiver?: string;
  amount?: string;
  destinationCallerB64?: string;
  mintRecipientB64?: string;
  destinationDomain?: number;
  channelId?: string;
}

export interface TrackerManagerDependencies {
  repository: TxTrackerRepository;
  rpcFactory: RpcClientFactory;
  chainRegistry: ChainRegistry;
  chainPollingConfigs: ChainPollingConfigs;
  logger: AppLogger;
  eventEmitter?: FlowStatusEventEmitter;
}

const POLLER_SOURCE = 'poller' as const;

export function createTrackerManager({
  repository,
  rpcFactory,
  chainRegistry: _chainRegistry,
  chainPollingConfigs,
  logger,
  eventEmitter = getFlowStatusEmitter(),
}: TrackerManagerDependencies): TrackerManager {
  const activeFlows = new Map<string, AbortController>();

  function getPollingConfig(chainId: string): ChainPollingConfig {
    return getChainPollingConfig(chainPollingConfigs, chainId);
  }

  function emitStatusUpdate(update: TxStatusUpdate): void {
    eventEmitter.emitStatusUpdate(update);
  }

  async function updateChainProgress(
    flowId: string,
    chain: keyof ChainProgress,
    updates: Partial<ChainProgressEntry>
  ): Promise<TrackedTransaction | null> {
    const flow = await repository.findById(flowId);
    if (!flow) return null;

    const currentProgress = flow.chainProgress || {};
    const chainEntry = currentProgress[chain] || {};
    const updatedEntry = { ...chainEntry, ...updates };
    const updatedProgress: ChainProgress = {
      ...currentProgress,
      [chain]: updatedEntry,
    };

    logger.debug(
      {
        flowId,
        chain,
        updates,
        currentChainEntry: chainEntry,
        updatedChainEntry: updatedEntry,
        updatedProgress,
      },
      'Updating chain progress'
    );

    const result = await repository.updateChainProgress(flowId, {
      chainProgress: updatedProgress,
    });

    logger.debug(
      {
        flowId,
        chain,
        resultChainProgress: result?.chainProgress,
        resultChainStatus: result?.chainProgress?.[chain]?.status,
      },
      'Chain progress updated'
    );

    return result;
  }

  function addStatusLog(
    flowId: string,
    chain: keyof ChainProgress,
    stage: string,
    status: 'pending' | 'confirmed' | 'failed',
    detail?: Record<string, unknown>
  ): Promise<void> {
    return repository.addStatusLog({
      transactionId: flowId,
      status: stage,
      chain,
      source: POLLER_SOURCE,
      detail: {
        status,
        ...detail,
      },
    });
  }

  async function ensureStartBlock(
    flow: TrackedTransaction,
    chain: keyof ChainProgress,
    rpcClient: TendermintRpcClient,
    blockWindowBackscan: number
  ): Promise<number> {
    const currentProgress = flow.chainProgress ?? {};
    const chainEntry = currentProgress[chain];

    if (chainEntry?.startBlock !== undefined) {
      return chainEntry.startBlock;
    }

    const latest = await rpcClient.getLatestBlockHeight();
    const startBlock = Math.max(0, latest - blockWindowBackscan);
    logger.debug({ flowId: flow.id, chain, startBlock, latest }, 'Persisting start block for flow');

    const updatedEntry: ChainProgressEntry = {
      ...(chainEntry ?? {}),
      startBlock,
    };

    const updatedProgress: ChainProgress = {
      ...currentProgress,
      [chain]: updatedEntry,
    };

    await repository.updateChainProgress(flow.id, {
      chainProgress: updatedProgress,
      nextCheckAfter: new Date(),
    });

    // Mutate local flow object to avoid re-fetch
    flow.chainProgress = updatedProgress;

    return startBlock;
  }

  async function trackDepositFlow(
    flow: TrackedTransaction,
    params: FlowTrackingParams
  ): Promise<void> {
    const abortController = new AbortController();
    activeFlows.set(flow.id, abortController);

    try {
      logger.debug(
        {
          flowId: flow.id,
          params,
          chainProgress: flow.chainProgress ?? null,
        },
        'Starting deposit flow tracking'
      );
      // Step 1: Track EVM burn
      const evmProgress = flow.chainProgress?.evm;
      const hasEvmPrereqs = Boolean(params.evmBurnTxHash && evmProgress);
      logger.debug(
        {
          flowId: flow.id,
          hasEvmPrereqs,
          hasEvmBurnTxHash: Boolean(params.evmBurnTxHash),
          hasEvmProgress: Boolean(evmProgress),
        },
        'Evaluated EVM burn polling prerequisites'
      );
      if (hasEvmPrereqs) {
        logger.info({ flowId: flow.id }, 'Starting EVM burn tracking');
        const evmChain = flow.initialChain || flow.chain;
        const pollConfig = getPollingConfig(evmChain);
        const rpcClient = rpcFactory(evmChain) as EvmRpcClient;
        const evmPoller = createEvmPoller(rpcClient, logger);

        const evmResult = await evmPoller.pollUsdcMint(
          {
            flowId: flow.id,
            chain: evmChain,
            usdcAddress: params.usdcAddress || '',
            recipient: params.recipient || '',
            amountBaseUnits: params.amountBaseUnits || '0',
            fromBlock: flow.chainProgress.evm.startBlock
              ? BigInt(flow.chainProgress.evm.startBlock)
              : undefined,
            timeoutMs: pollConfig.maxDurationMin * 60 * 1000,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            emitStatusUpdate({
              flowId: flow.id,
              chain: 'evm',
              stage: 'evm_burn_polling',
              status: 'pending',
              occurredAt: new Date(),
              source: POLLER_SOURCE,
              metadata: update,
            });
          }
        );

        if (abortController.signal.aborted) return;

        if (evmResult.found && evmResult.txHash) {
          await updateChainProgress(flow.id, 'evm', {
            status: 'confirmed',
            txHash: evmResult.txHash,
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'evm', 'evm_burn_confirmed', 'confirmed', {
            txHash: evmResult.txHash,
            blockNumber: evmResult.blockNumber?.toString(),
          });
          emitStatusUpdate({
            flowId: flow.id,
            chain: 'evm',
            stage: 'evm_burn_confirmed',
            status: 'confirmed',
            txHash: evmResult.txHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });
        } else {
          throw new Error('EVM burn not found');
        }
      } else {
        logger.debug(
          {
            flowId: flow.id,
            reason: 'missing_prerequisites',
            hasEvmBurnTxHash: Boolean(params.evmBurnTxHash),
            hasEvmChainProgress: Boolean(flow.chainProgress?.evm),
          },
          'Skipping EVM burn polling step'
        );
      }

      // Step 2: Track Noble CCTP mint and IBC forward
      const hasNoblePrereqs = Boolean(params.forwardingAddress && params.namadaReceiver);
      logger.debug(
        {
          flowId: flow.id,
          hasNoblePrereqs,
          forwardingAddress: params.forwardingAddress,
          namadaReceiver: params.namadaReceiver,
        },
        'Evaluated Noble polling prerequisites'
      );
      if (hasNoblePrereqs) {
        logger.info({ flowId: flow.id }, 'Starting Noble tracking');
        const nobleChain = 'noble-testnet'; // Get from registry or use default
        const pollConfig = getPollingConfig(nobleChain);
        const rpcClient = rpcFactory(nobleChain) as TendermintRpcClient;
        const noblePoller = createNoblePoller(rpcClient, logger);

        const startHeight = await ensureStartBlock(
          flow,
          'noble',
          rpcClient,
          pollConfig.blockWindowBackscan
        );
        logger.debug(
          { flowId: flow.id, startHeight },
          'Using start height for Noble polling'
        );

        const nobleResult = await noblePoller.pollForDeposit(
          {
            flowId: flow.id,
            chain: nobleChain,
            startHeight,
            forwardingAddress: params.forwardingAddress,
            expectedAmountUusdc: params.expectedAmountUusdc,
            namadaReceiver: params.namadaReceiver,
            timeoutMs: pollConfig.maxDurationMin * 60 * 1000,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            if (update.receivedFound) {
              emitStatusUpdate({
                flowId: flow.id,
                chain: nobleChain,
                stage: 'noble_cctp_minted',
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
            if (update.forwardFound) {
              emitStatusUpdate({
                flowId: flow.id,
                chain: nobleChain,
                stage: 'noble_ibc_forwarded',
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        if (abortController.signal.aborted) return;

        if (nobleResult.receivedFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'noble', 'noble_cctp_minted', 'confirmed');
        }

        if (nobleResult.forwardFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'noble', 'noble_ibc_forwarded', 'confirmed');
        }

        if (!nobleResult.receivedFound || !nobleResult.forwardFound) {
          throw new Error('Noble deposit tracking incomplete');
        }
      } else {
        logger.warn(
          {
            flowId: flow.id,
            reason: 'missing_prerequisites',
            forwardingAddress: params.forwardingAddress,
            namadaReceiver: params.namadaReceiver,
          },
          'Cannot start Noble polling due to missing parameters'
        );
      }

      // Step 3: Track Namada receive
      const hasNamadaPrereqs = Boolean(params.namadaReceiver);
      logger.debug(
        {
          flowId: flow.id,
          hasNamadaPrereqs,
          namadaReceiver: params.namadaReceiver,
        },
        'Evaluated Namada polling prerequisites'
      );
      if (hasNamadaPrereqs) {
        logger.info({ flowId: flow.id }, 'Starting Namada tracking');
        const namadaChainId = 'namada-testnet'; // Chain ID for RPC client and polling config
        const namadaChain = 'namada' as keyof ChainProgress; // Chain key for ChainProgress
        const pollConfig = getPollingConfig(namadaChainId);
        const rpcClient = rpcFactory(namadaChainId) as TendermintRpcClient;
        const namadaPoller = createNamadaPoller(rpcClient, logger);

        const startHeight = await ensureStartBlock(
          flow,
          namadaChain,
          rpcClient,
          pollConfig.blockWindowBackscan
        );
        logger.debug(
          { flowId: flow.id, startHeight },
          'Using start height for Namada polling'
        );

        const namadaResult = await namadaPoller.pollForDeposit(
          {
            flowId: flow.id,
            chain: namadaChainId,
            startHeight,
            forwardingAddress: params.forwardingAddress,
            namadaReceiver: params.namadaReceiver,
            expectedAmountUusdc: params.expectedAmountUusdc,
            timeoutMs: pollConfig.maxDurationMin * 60 * 1000,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            if (update.ackFound) {
              emitStatusUpdate({
                flowId: flow.id,
                chain: namadaChain,
                stage: 'namada_received',
                status: 'confirmed',
                txHash: update.namadaTxHash as string | undefined,
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        if (abortController.signal.aborted) return;

        logger.debug(
          {
            flowId: flow.id,
            namadaResult,
            hasFound: Boolean(namadaResult.found),
            hasNamadaTxHash: Boolean(namadaResult.namadaTxHash),
            conditionMet: Boolean(namadaResult.found && namadaResult.namadaTxHash),
          },
          'Namada polling result evaluation'
        );

        if (namadaResult.found && namadaResult.namadaTxHash) {
          logger.info(
            { flowId: flow.id, namadaTxHash: namadaResult.namadaTxHash },
            'Updating Namada chain progress to confirmed'
          );
          await updateChainProgress(flow.id, namadaChain, {
            status: 'confirmed',
            txHash: namadaResult.namadaTxHash,
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, namadaChain, 'namada_received', 'confirmed', {
            txHash: namadaResult.namadaTxHash,
          });
          emitStatusUpdate({
            flowId: flow.id,
            chain: 'namada',
            stage: 'completed',
            status: 'confirmed',
            txHash: namadaResult.namadaTxHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });

          // Mark flow as completed
          await repository.update(flow.id, {
            status: 'completed',
          });
        } else {
          throw new Error('Namada receive not found');
        }
      } else {
        logger.warn(
          {
            flowId: flow.id,
            reason: 'missing_namada_receiver',
          },
          'Cannot start Namada polling due to missing namadaReceiver'
        );
      }
    } catch (error) {
      logger.error({ err: error, flowId: flow.id }, 'Deposit flow tracking error');
      await repository.update(flow.id, {
        status: 'failed',
        errorState: {
          error: error instanceof Error ? error.message : String(error),
          occurredAt: new Date().toISOString(),
        },
      });
      emitStatusUpdate({
        flowId: flow.id,
        chain: 'evm', // Default to initial chain
        stage: 'failed',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        occurredAt: new Date(),
        source: POLLER_SOURCE,
      });
    } finally {
      activeFlows.delete(flow.id);
    }
  }

  async function trackPaymentFlow(
    flow: TrackedTransaction,
    params: FlowTrackingParams
  ): Promise<void> {
    const abortController = new AbortController();
    activeFlows.set(flow.id, abortController);

    try {
      // Step 1: Track Namada IBC send
      if (params.namadaIbcTxHash) {
        logger.info({ flowId: flow.id }, 'Starting Namada IBC tracking');
        // TODO: Implement Namada IBC send tracking
        // For now, assume it's already confirmed if txHash provided
        const namadaChainId = 'namada-testnet'; // Chain ID for RPC client and polling config
        const namadaChain = 'namada' as keyof ChainProgress; // Chain key for ChainProgress
        await updateChainProgress(flow.id, namadaChain, {
          status: 'confirmed',
          txHash: params.namadaIbcTxHash,
          lastCheckedAt: new Date(),
        });
      }

      // Step 2: Track Noble receive and CCTP burn
      if (params.memoJson && params.receiver && params.amount) {
        logger.info({ flowId: flow.id }, 'Starting Noble payment tracking');
        const nobleChain = 'noble';
        const pollConfig = getPollingConfig(nobleChain);
        const rpcClient = rpcFactory(nobleChain) as TendermintRpcClient;
        const noblePoller = createNoblePoller(rpcClient, logger);

        const startHeight =
          flow.chainProgress?.noble?.startBlock ??
          (await rpcClient.getLatestBlockHeight()) - pollConfig.blockWindowBackscan;

        const nobleResult = await noblePoller.pollForOrbiter(
          {
            flowId: flow.id,
            chain: nobleChain,
            startHeight,
            memoJson: params.memoJson,
            receiver: params.receiver,
            amount: params.amount,
            destinationCallerB64: params.destinationCallerB64,
            mintRecipientB64: params.mintRecipientB64,
            destinationDomain: params.destinationDomain,
            channelId: params.channelId,
            timeoutMs: pollConfig.maxDurationMin * 60 * 1000,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            if (update.ackFound) {
              emitStatusUpdate({
                flowId: flow.id,
                chain: nobleChain,
                stage: 'noble_received',
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
            if (update.cctpFound) {
              emitStatusUpdate({
                flowId: flow.id,
                chain: nobleChain,
                stage: 'noble_cctp_burned',
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        if (abortController.signal.aborted) return;

        if (nobleResult.ackFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'noble', 'noble_received', 'confirmed');
        }

        if (nobleResult.cctpFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'noble', 'noble_cctp_burned', 'confirmed');
        }
      }

      // Step 3: Track EVM mint
      if (params.mintRecipientB64) {
        logger.info({ flowId: flow.id }, 'Starting EVM mint tracking');
        const evmChain = flow.destinationChain || flow.chain; // Use destinationChain for payment flows
        const pollConfig = getPollingConfig(evmChain);
        const rpcClient = rpcFactory(evmChain) as EvmRpcClient;
        const evmPoller = createEvmPoller(rpcClient, logger);

        // TODO: Extract recipient address from base64 or params
        const evmResult = await evmPoller.pollUsdcMint(
          {
            flowId: flow.id,
            chain: evmChain,
            usdcAddress: params.usdcAddress || '',
            recipient: params.recipient || '',
            amountBaseUnits: params.amountBaseUnits || '0',
            timeoutMs: pollConfig.maxDurationMin * 60 * 1000,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            emitStatusUpdate({
              flowId: flow.id,
              chain: 'evm',
              stage: 'evm_mint_polling',
              status: 'pending',
              occurredAt: new Date(),
              source: POLLER_SOURCE,
              metadata: update,
            });
          }
        );

        if (abortController.signal.aborted) return;

        if (evmResult.found && evmResult.txHash) {
          await updateChainProgress(flow.id, 'evm', {
            status: 'confirmed',
            txHash: evmResult.txHash,
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, 'evm', 'evm_mint_confirmed', 'confirmed', {
            txHash: evmResult.txHash,
            blockNumber: evmResult.blockNumber?.toString(),
          });
          emitStatusUpdate({
            flowId: flow.id,
            chain: 'evm',
            stage: 'completed',
            status: 'confirmed',
            txHash: evmResult.txHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });

          await repository.update(flow.id, {
            status: 'completed',
          });
        }
      }
    } catch (error) {
      logger.error({ err: error, flowId: flow.id }, 'Payment flow tracking error');
      await repository.update(flow.id, {
        status: 'failed',
        errorState: {
          error: error instanceof Error ? error.message : String(error),
          occurredAt: new Date().toISOString(),
        },
      });
    } finally {
      activeFlows.delete(flow.id);
    }
  }

  return {
    async startFlow(flow, params) {
      if (flow.flowType === 'deposit') {
        await trackDepositFlow(flow, params);
      } else if (flow.flowType === 'payment') {
        await trackPaymentFlow(flow, params);
      } else {
        throw new Error(`Unknown flow type: ${flow.flowType}`);
      }
    },

    async resumeFlow(flow) {
      // Extract params from flow metadata/chainProgress
      const params: FlowTrackingParams = {
        evmBurnTxHash: flow.txHash,
        ...((flow.metadata as FlowTrackingParams) || {}),
      };
      await this.startFlow(flow, params);
    },

    stopFlow(flowId) {
      const controller = activeFlows.get(flowId);
      if (controller) {
        controller.abort();
        activeFlows.delete(flowId);
        logger.info({ flowId }, 'Stopped flow tracking');
      }
    },
  };
}

