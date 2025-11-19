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
import { sleep } from './pollers/base.js';
import type { TxTrackerRepository } from './repository.js';
import type { TxTrackerService } from './service.js';
import { getFlowStatusEmitter, type FlowStatusEventEmitter } from './events.js';
import {
  DEPOSIT_STAGES,
  PAYMENT_STAGES,
  type FlowStatus,
  isFinalFlowStatus,
} from '../../shared/flowStages.js';
import type {
  ChainProgress,
  ChainProgressEntry,
  TrackedTransaction,
  TxStatusUpdate,
} from './types.js';
import { buildFlowTrackingParams } from './params.js';

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
  service: TxTrackerService;
  rpcFactory: RpcClientFactory;
  chainRegistry: ChainRegistry;
  chainPollingConfigs: ChainPollingConfigs;
  logger: AppLogger;
  eventEmitter?: FlowStatusEventEmitter;
}

const POLLER_SOURCE = 'poller' as const;

export function createTrackerManager({
  repository,
  service,
  rpcFactory,
  chainRegistry,
  chainPollingConfigs,
  logger,
  eventEmitter = getFlowStatusEmitter(),
}: TrackerManagerDependencies): TrackerManager {
  const activeFlows = new Map<string, AbortController>();
  const flowTimeouts = new Map<string, { stageTimeouts: Map<string, { timeoutMs: number; startTime: number }> }>();

  function getPollingConfig(chainId: string): ChainPollingConfig {
    return getChainPollingConfig(chainPollingConfigs, chainId);
  }

  function emitStatusUpdate(update: TxStatusUpdate): void {
    eventEmitter.emitStatusUpdate(update);
  }

  /**
   * Helper function to emit status update and add stage to chainProgress.
   * This ensures stages are persisted to the database while maintaining real-time event notifications.
   */
  async function emitAndAddStage(update: TxStatusUpdate): Promise<void> {
    // Emit for real-time notifications
    emitStatusUpdate(update);
    
    // Add to chainProgress stages array
    try {
      await service.appendClientStage({
        flowId: update.flowId,
        chain: update.chain,
        stage: update.stage,
        status: update.status,
        txHash: update.txHash,
        occurredAt: update.occurredAt,
        message: update.message,
        metadata: update.metadata,
        source: update.source,
      });
    } catch (error) {
      // Log error but don't fail the flow - stages are informational
      logger.warn(
        {
          flowId: update.flowId,
          chain: update.chain,
          stage: update.stage,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to add stage to chainProgress (non-fatal)'
      );
    }
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

  /**
   * Handle polling timeout by marking flow as 'undetermined'
   */
  async function handlePollingTimeout(
    flowId: string,
    stage: string,
    timeoutMs: number,
    startTime: number
  ): Promise<void> {
    const flow = await repository.findById(flowId);
    if (!flow) {
      logger.warn({ flowId }, 'Flow not found when handling timeout');
      return;
    }

    // Check if flow already completed or failed - don't overwrite
    if (isFinalFlowStatus(flow.status)) {
      logger.debug(
        { flowId, currentStatus: flow.status, stage },
        'Flow already resolved, skipping timeout handling'
      );
      return;
    }

    const elapsedMs = Date.now() - startTime;
    const timeoutInfo = {
      stage,
      timeoutMs,
      elapsedMs,
      occurredAt: new Date().toISOString(),
    };

    logger.warn(
      {
        flowId,
        stage,
        timeoutMs,
        elapsedMs,
      },
      'Polling timeout occurred, marking flow as undetermined'
    );

    // Update flow status to 'undetermined'
    await repository.update(flowId, {
      status: 'undetermined' as FlowStatus,
      errorState: {
        reason: 'timeout',
        ...timeoutInfo,
      },
    });

    // Add status log entry
    await addStatusLog(flowId, stage.split('_')[0] as keyof ChainProgress, `${stage}_timeout`, 'failed', {
      timeout: true,
      ...timeoutInfo,
    });

    // Emit status update event and add stage
    await emitAndAddStage({
      flowId,
      chain: stage.split('_')[0] as 'evm' | 'noble' | 'namada',
      stage: `${stage}_timeout`,
      status: 'failed',
      message: `Polling timeout after ${elapsedMs}ms (limit: ${timeoutMs}ms)`,
      occurredAt: new Date(),
      source: POLLER_SOURCE,
      metadata: timeoutInfo,
    });
  }

  /**
   * Check if abort was due to timeout for a specific stage
   */
  function isTimeoutAbort(flowId: string, stage: string): boolean {
    const timeoutInfo = flowTimeouts.get(flowId);
    if (!timeoutInfo) return false;

    const stageTimeout = timeoutInfo.stageTimeouts.get(stage);
    if (!stageTimeout) return false;

    const elapsedMs = Date.now() - stageTimeout.startTime;
    return elapsedMs >= stageTimeout.timeoutMs;
  }

  /**
   * Track timeout for a polling stage
   */
  function trackStageTimeout(flowId: string, stage: string, timeoutMs: number): void {
    let flowTimeout = flowTimeouts.get(flowId);
    if (!flowTimeout) {
      flowTimeout = { stageTimeouts: new Map() };
      flowTimeouts.set(flowId, flowTimeout);
    }
    flowTimeout.stageTimeouts.set(stage, {
      timeoutMs,
      startTime: Date.now(),
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

    if (chainEntry?.startBlock !== undefined && chainEntry.startBlock !== null) {
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

    // Initialize timeout tracking for this flow
    flowTimeouts.set(flow.id, { stageTimeouts: new Map() });

    // Track current chain/stage for error handling context
    let currentChain: keyof ChainProgress = 'evm'; // Default to initial chain
    let currentStage: string = '';

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
        currentChain = 'evm';
        currentStage = 'evm_burn';
        logger.info({ flowId: flow.id }, 'Starting EVM burn tracking');
        const evmChain = flow.initialChain || flow.chain;
        const pollConfig = getPollingConfig(evmChain);
        const rpcClient = rpcFactory(evmChain) as EvmRpcClient;
        const evmPoller = createEvmPoller(rpcClient, logger);

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'evm_burn', stageTimeoutMs);

        const evmResult = await evmPoller.pollUsdcMint(
          {
            flowId: flow.id,
            chain: evmChain,
            usdcAddress: params.usdcAddress || '',
            recipient: params.recipient || '',
            amountBaseUnits: params.amountBaseUnits || '0',
            fromBlock: flow.chainProgress?.evm?.startBlock != null
              ? BigInt(flow.chainProgress.evm.startBlock)
              : undefined,
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          async (update) => {
            await emitAndAddStage({
              flowId: flow.id,
              chain: 'evm',
              stage: DEPOSIT_STAGES.EVM_BURN_POLLING,
              status: 'confirmed',
              occurredAt: new Date(),
              source: POLLER_SOURCE,
              metadata: update,
            });
          }
        );

        // Check for timeout (even if external signal isn't aborted, poller's internal timeout may have fired)
        const evmTimeoutOccurred = isTimeoutAbort(flow.id, 'evm_burn');
        if (abortController.signal.aborted || evmTimeoutOccurred) {
          if (evmTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('evm_burn');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'evm_burn', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

        if (evmResult.found && evmResult.txHash) {
          await updateChainProgress(flow.id, 'evm', {
            status: 'confirmed',
            txHash: evmResult.txHash,
            lastCheckedAt: new Date(),
          });
          // Note: Status log created by emitAndAddStage below (which calls appendClientStage -> addStatusLog)
          await emitAndAddStage({
            flowId: flow.id,
            chain: 'evm',
            stage: DEPOSIT_STAGES.EVM_BURN_CONFIRMED,
            status: 'confirmed',
            txHash: evmResult.txHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
            metadata: {
              blockNumber: evmResult.blockNumber?.toString(),
            },
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
        currentChain = 'noble';
        currentStage = 'noble_deposit';
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

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'noble_deposit', stageTimeoutMs);

        // Emit polling stage when starting Noble polling
        await emitAndAddStage({
          flowId: flow.id,
          chain: 'noble',
          stage: DEPOSIT_STAGES.NOBLE_POLLING,
          status: 'confirmed',
          occurredAt: new Date(),
          source: POLLER_SOURCE,
        });

        // Track which stages have been emitted to prevent duplicates
        let nobleCctpMintedEmitted = false;
        let nobleIbcForwardedEmitted = false;

        const nobleResult = await noblePoller.pollForDeposit(
          {
            flowId: flow.id,
            chain: nobleChain,
            startHeight,
            forwardingAddress: params.forwardingAddress,
            expectedAmountUusdc: params.expectedAmountUusdc,
            namadaReceiver: params.namadaReceiver,
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            blockRequestDelayMs: pollConfig.blockRequestDelayMs,
            abortSignal: abortController.signal,
          },
          async (update) => {
            if (update.receivedFound && !nobleCctpMintedEmitted) {
              nobleCctpMintedEmitted = true;
              await emitAndAddStage({
                flowId: flow.id,
                chain: 'noble',
                stage: DEPOSIT_STAGES.NOBLE_CCTP_MINTED,
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
            if (update.forwardFound && !nobleIbcForwardedEmitted) {
              nobleIbcForwardedEmitted = true;
              await emitAndAddStage({
                flowId: flow.id,
                chain: 'noble',
                stage: DEPOSIT_STAGES.NOBLE_IBC_FORWARDED,
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        // Check for timeout (even if external signal isn't aborted, poller's internal timeout may have fired)
        const nobleTimeoutOccurred = isTimeoutAbort(flow.id, 'noble_deposit');
        if (abortController.signal.aborted || nobleTimeoutOccurred) {
          if (nobleTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('noble_deposit');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'noble_deposit', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

        if (nobleResult.receivedFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          // Note: Status log already created by emitAndAddStage in callback (line 507-514)
        }

        if (nobleResult.forwardFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          // Note: Status log already created by emitAndAddStage in callback (line 517-524)
        }

        // Check for retry exhaustion - treat as timeout
        if (nobleResult.retryExhausted) {
          logger.warn(
            { flowId: flow.id },
            'Noble deposit poll: RPC retry exhaustion detected, treating as timeout'
          );
          const timeoutInfo = flowTimeouts.get(flow.id);
          const stageTimeout = timeoutInfo?.stageTimeouts.get('noble_deposit');
          if (stageTimeout) {
            await handlePollingTimeout(flow.id, 'noble_deposit', stageTimeout.timeoutMs, stageTimeout.startTime);
          }
          return;
        }

        // Only throw error if results are incomplete AND it wasn't due to timeout
        if (!nobleResult.receivedFound || !nobleResult.forwardFound) {
          // Check again if timeout occurred (may have happened between checks)
          if (!isTimeoutAbort(flow.id, 'noble_deposit')) {
            throw new Error('Noble deposit tracking incomplete');
          }
          // If timeout occurred, handlePollingTimeout was already called above, just return
          return;
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
        currentChain = 'namada';
        currentStage = 'namada_receive';
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

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'namada_receive', stageTimeoutMs);

        // Emit polling stage when starting Namada polling
        await emitAndAddStage({
          flowId: flow.id,
          chain: namadaChain,
          stage: DEPOSIT_STAGES.NAMADA_POLLING,
          status: 'confirmed',
          occurredAt: new Date(),
          source: POLLER_SOURCE,
        });

        const namadaResult = await namadaPoller.pollForDeposit(
          {
            flowId: flow.id,
            chain: namadaChainId,
            startHeight,
            forwardingAddress: params.forwardingAddress,
            namadaReceiver: params.namadaReceiver,
            expectedAmountUusdc: params.expectedAmountUusdc,
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            blockRequestDelayMs: pollConfig.blockRequestDelayMs,
            abortSignal: abortController.signal,
          },
          async (update) => {
            if (update.ackFound) {
              await emitAndAddStage({
                flowId: flow.id,
                chain: namadaChain,
                stage: DEPOSIT_STAGES.NAMADA_RECEIVED,
                status: 'confirmed',
                txHash: update.namadaTxHash as string | undefined,
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        // Check for timeout (even if external signal isn't aborted, poller's internal timeout may have fired)
        const namadaTimeoutOccurred = isTimeoutAbort(flow.id, 'namada_receive');
        if (abortController.signal.aborted || namadaTimeoutOccurred) {
          if (namadaTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('namada_receive');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'namada_receive', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

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
          await addStatusLog(flow.id, namadaChain, DEPOSIT_STAGES.NAMADA_RECEIVED, 'confirmed', {
            txHash: namadaResult.namadaTxHash,
          });
          // Add COMPLETED stage - appendClientStage will automatically update flow status to 'completed'
          // via determineOverallStatus when it detects the COMPLETED stage
          await emitAndAddStage({
            flowId: flow.id,
            chain: 'namada',
            stage: DEPOSIT_STAGES.COMPLETED,
            status: 'confirmed',
            txHash: namadaResult.namadaTxHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });
          // Note: No need to call repository.update here - appendClientStage already handles status update
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
      // Check current status before overwriting - preserve 'undetermined' status
      const currentFlow = await repository.findById(flow.id);
      const currentStatus = currentFlow?.status;
      
      // Determine if this is a timeout-related error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeoutError = errorMessage.includes('timeout') || errorMessage.includes('incomplete');
      
      // Use appropriate log level: WARN for timeout/expected errors, ERROR for unexpected failures
      if (isTimeoutError && currentStatus === 'undetermined') {
        logger.warn(
          { flowId: flow.id, error: errorMessage },
          'Deposit flow tracking timeout (already marked as undetermined)'
        );
        // Don't overwrite 'undetermined' status
        return;
      }
      
      // Only set to 'failed' if status is still 'pending' (not already 'undetermined' or 'completed')
      if (currentStatus && !isFinalFlowStatus(currentStatus)) {
        const logLevel = isTimeoutError ? 'warn' : 'error';
        logger[logLevel](
          { flowId: flow.id, error: errorMessage },
          isTimeoutError ? 'Deposit flow tracking timeout' : 'Deposit flow tracking error'
        );
        
        await repository.update(flow.id, {
          status: 'failed' as FlowStatus,
          errorState: {
            error: errorMessage,
            occurredAt: new Date().toISOString(),
          },
        });
        await emitAndAddStage({
          flowId: flow.id,
          chain: currentChain, // Use the chain where error occurred
          stage: DEPOSIT_STAGES.FAILED,
          status: 'failed',
          message: errorMessage,
          occurredAt: new Date(),
          source: POLLER_SOURCE,
        });
      } else {
        logger.debug(
          { flowId: flow.id, currentStatus, error: errorMessage },
          'Skipping error handler - flow already resolved'
        );
      }
    } finally {
      activeFlows.delete(flow.id);
      flowTimeouts.delete(flow.id);
    }
  }

  async function trackPaymentFlow(
    flow: TrackedTransaction,
    params: FlowTrackingParams
  ): Promise<void> {
    const abortController = new AbortController();
    activeFlows.set(flow.id, abortController);

    // Initialize timeout tracking for this flow
    flowTimeouts.set(flow.id, { stageTimeouts: new Map() });

    // Track current chain/stage for error handling context
    let currentChain: keyof ChainProgress = 'namada'; // Default to initial chain for payment flow
    let currentStage: string = '';

    try {
      // Step 1: Track Namada IBC send
      // NOTE: Namada polling is currently disabled to mirror deposit flow behavior
      // (deposits skip EVM polling, payments skip Namada polling)
      // To re-enable: change hasNamadaPrereqs to check actual prerequisites:
      //   const hasNamadaPrereqs = Boolean(params.namadaIbcTxHash && namadaProgress);
      const namadaProgress = flow.chainProgress?.namada;
      const hasNamadaPrereqs = false; // Disabled: set to Boolean(params.namadaIbcTxHash && namadaProgress) to re-enable
      logger.debug(
        {
          flowId: flow.id,
          hasNamadaPrereqs,
          hasNamadaIbcTxHash: Boolean(params.namadaIbcTxHash),
          hasNamadaChainProgress: Boolean(namadaProgress),
        },
        'Evaluated Namada IBC send polling prerequisites'
      );
      if (hasNamadaPrereqs) {
        currentChain = 'namada';
        currentStage = 'namada_ibc_send';
        logger.info({ flowId: flow.id }, 'Starting Namada IBC send tracking');
        const namadaChainId = 'namada-testnet'; // Chain ID for RPC client and polling config
        const namadaChain = 'namada' as keyof ChainProgress; // Chain key for ChainProgress
        const pollConfig = getPollingConfig(namadaChainId);
        const rpcClient = rpcFactory(namadaChainId) as TendermintRpcClient;

        const startHeight = await ensureStartBlock(
          flow,
          namadaChain,
          rpcClient,
          pollConfig.blockWindowBackscan
        );
        logger.debug(
          { flowId: flow.id, startHeight, txHash: params.namadaIbcTxHash },
          'Using start height for Namada IBC send polling'
        );

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'namada_ibc_send', stageTimeoutMs);

        // Note: We don't emit a polling stage here since PAYMENT_STAGES doesn't have a separate polling stage
        // We'll emit NAMADA_IBC_SENT when the transaction is confirmed

        // Use Namada poller to track IBC send transaction
        const namadaPoller = createNamadaPoller(rpcClient, logger);
        const namadaResult = await namadaPoller.pollForPayment(
          {
            flowId: flow.id,
            chain: namadaChainId,
            startHeight,
            namadaIbcTxHash: params.namadaIbcTxHash,
            memoJson: params.memoJson,
            receiver: params.receiver,
            amount: params.amount,
            denom: 'uusdc',
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            blockRequestDelayMs: pollConfig.blockRequestDelayMs,
            abortSignal: abortController.signal,
          },
          (update) => {
            logger.debug(
              { flowId: flow.id, update },
              'Namada payment poll update'
            );
          }
        );

        // Check for timeout
        const namadaIbcTimeoutOccurred = isTimeoutAbort(flow.id, 'namada_ibc_send');
        if (abortController.signal.aborted || namadaIbcTimeoutOccurred) {
          if (namadaIbcTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('namada_ibc_send');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'namada_ibc_send', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

        if (namadaResult.success && namadaResult.namadaTxHash) {
          const confirmedTxHash = namadaResult.namadaTxHash;
          await updateChainProgress(flow.id, namadaChain, {
            status: 'confirmed',
            txHash: confirmedTxHash,
            lastCheckedAt: new Date(),
          });
          await addStatusLog(flow.id, namadaChain, PAYMENT_STAGES.NAMADA_IBC_SENT, 'confirmed', {
            txHash: confirmedTxHash,
          });
          await emitAndAddStage({
            flowId: flow.id,
            chain: namadaChain,
            stage: PAYMENT_STAGES.NAMADA_IBC_SENT,
            status: 'confirmed',
            txHash: confirmedTxHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });
        } else {
          const errorMsg = namadaResult.error || 'Namada IBC send transaction not found or not confirmed';
          logger.error(
            { flowId: flow.id, error: namadaResult.error, found: namadaResult.found },
            'Namada IBC send tracking failed'
          );
          throw new Error(errorMsg);
        }
      } else {
        logger.debug(
          {
            flowId: flow.id,
            reason: 'disabled_to_mirror_deposit_flow',
            hasNamadaIbcTxHash: Boolean(params.namadaIbcTxHash),
            hasNamadaChainProgress: Boolean(namadaProgress),
          },
          'Skipping Namada IBC send polling step'
        );
      }

      // Step 2: Track Noble receive and CCTP burn
      const hasNoblePrereqs = Boolean(params.memoJson && params.receiver && params.amount);
      logger.debug(
        {
          flowId: flow.id,
          hasNoblePrereqs,
          hasMemoJson: Boolean(params.memoJson),
          hasReceiver: Boolean(params.receiver),
          hasAmount: Boolean(params.amount),
          memoJson: params.memoJson,
          receiver: params.receiver,
          amount: params.amount,
        },
        'Evaluated Noble payment polling prerequisites'
      );
      if (hasNoblePrereqs) {
        currentChain = 'noble';
        currentStage = 'noble_payment';
        logger.info({ flowId: flow.id }, 'Starting Noble payment tracking');
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

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'noble_payment', stageTimeoutMs);

        // Emit polling stage when starting Noble polling
        await emitAndAddStage({
          flowId: flow.id,
          chain: 'noble',
          stage: PAYMENT_STAGES.NOBLE_POLLING,
          status: 'confirmed',
          occurredAt: new Date(),
          source: POLLER_SOURCE,
        });

        // Track which stages have been emitted to prevent duplicates
        let nobleReceivedEmitted = false;
        let nobleCctpBurnedEmitted = false;

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
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            blockRequestDelayMs: pollConfig.blockRequestDelayMs,
            abortSignal: abortController.signal,
          },
          async (update) => {
            if (update.ackFound && !nobleReceivedEmitted) {
              nobleReceivedEmitted = true;
              await emitAndAddStage({
                flowId: flow.id,
                chain: 'noble',
                stage: PAYMENT_STAGES.NOBLE_RECEIVED,
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
            if (update.cctpFound && !nobleCctpBurnedEmitted) {
              nobleCctpBurnedEmitted = true;
              await emitAndAddStage({
                flowId: flow.id,
                chain: 'noble',
                stage: PAYMENT_STAGES.NOBLE_CCTP_BURNED,
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
              });
            }
          }
        );

        // Check for timeout (even if external signal isn't aborted, poller's internal timeout may have fired)
        const noblePaymentTimeoutOccurred = isTimeoutAbort(flow.id, 'noble_payment');
        if (abortController.signal.aborted || noblePaymentTimeoutOccurred) {
          if (noblePaymentTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('noble_payment');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'noble_payment', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

        if (nobleResult.ackFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          // Note: Status log already created by emitAndAddStage in callback (line 984-991)
        }

        if (nobleResult.cctpFound) {
          await updateChainProgress(flow.id, 'noble', {
            status: 'confirmed',
            lastCheckedAt: new Date(),
          });
          // Note: Status log already created by emitAndAddStage in callback (line 994-999)
        }

        // Check for retry exhaustion - treat as timeout
        if (nobleResult.retryExhausted) {
          logger.warn(
            { flowId: flow.id },
            'Noble payment poll: RPC retry exhaustion detected, treating as timeout'
          );
          const timeoutInfo = flowTimeouts.get(flow.id);
          const stageTimeout = timeoutInfo?.stageTimeouts.get('noble_payment');
          if (stageTimeout) {
            await handlePollingTimeout(flow.id, 'noble_payment', stageTimeout.timeoutMs, stageTimeout.startTime);
          }
          return;
        }
      } else {
        logger.debug(
          {
            flowId: flow.id,
            reason: 'missing_prerequisites',
            hasMemoJson: Boolean(params.memoJson),
            hasReceiver: Boolean(params.receiver),
            hasAmount: Boolean(params.amount),
          },
          'Skipping Noble payment polling step'
        );
      }

      // Step 3: Track EVM mint
      if (params.mintRecipientB64) {
        currentChain = 'evm';
        currentStage = 'evm_mint';
        logger.info({ flowId: flow.id }, 'Starting EVM mint tracking');
        const evmChain = flow.destinationChain || flow.chain; // Use destinationChain for payment flows
        const pollConfig = getPollingConfig(evmChain);
        const rpcClient = rpcFactory(evmChain) as EvmRpcClient;
        const evmPoller = createEvmPoller(rpcClient, logger);

        const stageTimeoutMs = pollConfig.maxDurationMin * 60 * 1000;
        trackStageTimeout(flow.id, 'evm_mint', stageTimeoutMs);

        // Extract recipient address: prefer params.recipient, otherwise decode from mintRecipientB64
        let recipientAddress = params.recipient;
        if (!recipientAddress && params.mintRecipientB64) {
          try {
            // Decode base64-encoded bytes32 address to get EVM address
            // mintRecipientB64 is a base64-encoded 32-byte value where the EVM address is in the last 20 bytes
            const decodedBytes = Buffer.from(params.mintRecipientB64, 'base64');
            if (decodedBytes.length >= 20) {
              // Extract last 20 bytes (EVM address)
              const addressBytes = decodedBytes.slice(-20);
              // Convert to hex string with 0x prefix
              recipientAddress = '0x' + Buffer.from(addressBytes).toString('hex');
              logger.debug(
                { flowId: flow.id, mintRecipientB64: params.mintRecipientB64, decodedAddress: recipientAddress },
                'Decoded EVM recipient address from base64'
              );
            } else {
              logger.warn(
                { flowId: flow.id, decodedLength: decodedBytes.length },
                'mintRecipientB64 decoded to less than 20 bytes, cannot extract EVM address'
              );
            }
          } catch (error) {
            logger.warn(
              { err: error, flowId: flow.id, mintRecipientB64: params.mintRecipientB64 },
              'Failed to decode mintRecipientB64, will use empty recipient'
            );
          }
        }

        if (!recipientAddress) {
          throw new Error('EVM recipient address not found in params.recipient or params.mintRecipientB64');
        }

        // Extract fromBlock from chain progress if available (for resuming)
        const evmProgress = flow.chainProgress?.evm;
        const fromBlock = evmProgress?.startBlock
          ? BigInt(evmProgress.startBlock)
          : undefined;
        
        logger.debug(
          { flowId: flow.id, fromBlock: fromBlock?.toString(), hasEvmProgress: Boolean(evmProgress) },
          'EVM mint polling with start block'
        );

        // Track if polling stage has been emitted (only emit first update)
        let evmPollingEmitted = false;

        const evmResult = await evmPoller.pollUsdcMint(
          {
            flowId: flow.id,
            chain: evmChain,
            usdcAddress: params.usdcAddress || '',
            recipient: recipientAddress,
            amountBaseUnits: params.amountBaseUnits || '0',
            fromBlock,
            timeoutMs: stageTimeoutMs,
            intervalMs: pollConfig.pollIntervalMs,
            abortSignal: abortController.signal,
          },
          async (update) => {
            // Only emit the first polling update to avoid cluttering the stages
            if (!evmPollingEmitted) {
              evmPollingEmitted = true;
              await emitAndAddStage({
                flowId: flow.id,
                chain: 'evm',
                stage: PAYMENT_STAGES.EVM_MINT_POLLING,
                status: 'confirmed',
                occurredAt: new Date(),
                source: POLLER_SOURCE,
                metadata: update,
              });
            }
          }
        );

        // Check for timeout (even if external signal isn't aborted, poller's internal timeout may have fired)
        const evmMintTimeoutOccurred = isTimeoutAbort(flow.id, 'evm_mint');
        if (abortController.signal.aborted || evmMintTimeoutOccurred) {
          if (evmMintTimeoutOccurred) {
            const timeoutInfo = flowTimeouts.get(flow.id);
            const stageTimeout = timeoutInfo?.stageTimeouts.get('evm_mint');
            if (stageTimeout) {
              await handlePollingTimeout(flow.id, 'evm_mint', stageTimeout.timeoutMs, stageTimeout.startTime);
            }
          }
          return;
        }

        if (evmResult.found && evmResult.txHash) {
          // Note: Status log and chain progress update created by emitAndAddStage below (which calls appendClientStage)
          await emitAndAddStage({
            flowId: flow.id,
            chain: 'evm',
            stage: PAYMENT_STAGES.EVM_MINT_CONFIRMED,
            status: 'confirmed',
            txHash: evmResult.txHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
            metadata: {
              blockNumber: evmResult.blockNumber?.toString(),
            },
          });
          // Add COMPLETED stage - appendClientStage will automatically update flow status to 'completed'
          // via determineOverallStatus when it detects the COMPLETED stage
          await emitAndAddStage({
            flowId: flow.id,
            chain: 'evm',
            stage: PAYMENT_STAGES.COMPLETED,
            status: 'confirmed',
            txHash: evmResult.txHash,
            occurredAt: new Date(),
            source: POLLER_SOURCE,
          });
          // Note: No need to call repository.update here - appendClientStage already handles status update
          // This ensures the COMPLETED stage is fully persisted before the flow is marked as completed
        }
      }
    } catch (error) {
      // Check current status before overwriting - preserve 'undetermined' status
      const currentFlow = await repository.findById(flow.id);
      const currentStatus = currentFlow?.status;
      
      // Determine if this is a timeout-related error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeoutError = errorMessage.includes('timeout') || errorMessage.includes('incomplete');
      
      // Use appropriate log level: WARN for timeout/expected errors, ERROR for unexpected failures
      if (isTimeoutError && currentStatus === 'undetermined') {
        logger.warn(
          { flowId: flow.id, error: errorMessage },
          'Payment flow tracking timeout (already marked as undetermined)'
        );
        // Don't overwrite 'undetermined' status
        return;
      }
      
      // Only set to 'failed' if status is still 'pending' (not already 'undetermined' or 'completed')
      if (currentStatus && !isFinalFlowStatus(currentStatus)) {
        const logLevel = isTimeoutError ? 'warn' : 'error';
        logger[logLevel](
          { flowId: flow.id, error: errorMessage },
          isTimeoutError ? 'Payment flow tracking timeout' : 'Payment flow tracking error'
        );
        
        await repository.update(flow.id, {
          status: 'failed' as FlowStatus,
          errorState: {
            error: errorMessage,
            occurredAt: new Date().toISOString(),
          },
        });
        await emitAndAddStage({
          flowId: flow.id,
          chain: currentChain, // Use the chain where error occurred
          stage: PAYMENT_STAGES.FAILED,
          status: 'failed',
          message: errorMessage,
          occurredAt: new Date(),
          source: POLLER_SOURCE,
        });
      } else {
        logger.debug(
          { flowId: flow.id, currentStatus, error: errorMessage },
          'Skipping error handler - flow already resolved'
        );
      }
    } finally {
      activeFlows.delete(flow.id);
      flowTimeouts.delete(flow.id);
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
      // Extract params from flow metadata/chainProgress using single source of truth
      // Pass chainRegistry to allow reconstruction of memoJson from destinationChain
      const params = buildFlowTrackingParams(flow, chainRegistry);
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

