import type { Job } from 'bullmq';
import type { AppLogger } from '../common/utils/logger.js';
import type { TrackerManager } from '../modules/tx-tracker/trackerManager.js';
import type { TxTrackerRepository } from '../modules/tx-tracker/repository.js';
import type { FlowTrackingParams } from '../modules/tx-tracker/trackerManager.js';

export interface TxPollingJobData {
  flowId: string;
  flowType: 'deposit' | 'payment';
  params: FlowTrackingParams;
}

export function createTxPollingProcessor(
  trackerManager: TrackerManager,
  repository: TxTrackerRepository,
  logger: AppLogger
) {
  return async (job: Job<TxPollingJobData>) => {
    const { flowId, params } = job.data;
    logger.info({ flowId, jobId: job.id }, 'Processing transaction polling job');

    try {
      const flow = await repository.findById(flowId);
      if (!flow) {
        throw new Error(`Flow ${flowId} not found`);
      }

      // Check if flow is already completed or failed
      if (flow.status === 'completed' || flow.status === 'failed') {
        logger.info({ flowId, status: flow.status }, 'Flow already finished, skipping');
        return { success: true, skipped: true };
      }

      // Start tracking via TrackerManager
      await trackerManager.startFlow(flow, params);

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

