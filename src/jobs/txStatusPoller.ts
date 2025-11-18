import type { Job } from 'bullmq';
import type { AppLogger } from '../common/utils/logger.js';
import type { TrackerManager } from '../modules/tx-tracker/trackerManager.js';
import type { TxTrackerRepository } from '../modules/tx-tracker/repository.js';
import type { FlowTrackingParams } from '../modules/tx-tracker/trackerManager.js';
import type { ChainRegistry } from '../config/chainRegistry.js';
import { buildFlowTrackingParams } from '../modules/tx-tracker/params.js';

export interface TxPollingJobData {
  flowId: string;
  flowType: 'deposit' | 'payment';
  params: FlowTrackingParams;
}

export function createTxPollingProcessor(
  trackerManager: TrackerManager,
  repository: TxTrackerRepository,
  logger: AppLogger,
  chainRegistry?: ChainRegistry
) {
  return async (job: Job<TxPollingJobData>) => {
    const { flowId, params } = job.data;
    logger.info({ flowId, jobId: job.id }, 'Processing transaction polling job');
    logger.debug({ flowId, params }, 'Tx polling job parameters received');

    try {
      const flow = await repository.findById(flowId);
      if (!flow) {
        throw new Error(`Flow ${flowId} not found`);
      }

      logger.debug(
        {
          flowId,
          status: flow.status,
          chainProgress: flow.chainProgress ?? null,
          hasMetadata: Boolean(flow.metadata),
        },
        'Loaded flow for polling'
      );

      // Check if flow is already completed or failed
      if (flow.status === 'completed' || flow.status === 'failed') {
        logger.info({ flowId, status: flow.status }, 'Flow already finished, skipping');
        return { success: true, skipped: true };
      }

      // Rebuild params from flow metadata to ensure we have the latest/complete params
      // This is important because job params might be stale or incomplete
      // Pass chainRegistry to allow reconstruction of memoJson from destinationChain
      const flowParams = buildFlowTrackingParams(flow, chainRegistry);
      logger.debug(
        {
          flowId,
          flowType: flow.flowType,
          metadataKeys: flow.metadata ? Object.keys(flow.metadata as Record<string, unknown>) : [],
          metadataSample: flow.metadata
            ? {
                memoJson: (flow.metadata as Record<string, unknown>).memoJson,
                receiver: (flow.metadata as Record<string, unknown>).receiver,
                amount: (flow.metadata as Record<string, unknown>).amount,
              }
            : null,
          paramsFromJob: params,
          paramsFromFlow: flowParams,
        },
        'Rebuilt tracking params from flow metadata'
      );

      // Start tracking via TrackerManager
      logger.debug({ flowId }, 'Invoking trackerManager.startFlow');
      await trackerManager.startFlow(flow, flowParams);

      logger.info({ flowId, jobId: job.id }, 'Transaction polling job completed');
      return { success: true };
    } catch (error) {
      logger.error(
        { err: error, flowId, jobId: job.id },
        'Transaction polling job failed'
      );
      throw error;
    }
  };
}

