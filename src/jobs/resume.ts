import type { AppLogger } from '../common/utils/logger.js';
import type { QueueManager } from './queue.js';
import type { TxTrackerService } from '../modules/tx-tracker/service.js';
import type { FlowTrackingParams } from '../modules/tx-tracker/trackerManager.js';

export async function resumeUnfinishedFlows(
  queueManager: QueueManager,
  txTrackerService: TxTrackerService,
  logger: AppLogger
): Promise<void> {
  logger.info('Resuming unfinished flows...');

  try {
    const unfinishedFlows = await txTrackerService.listUnfinishedFlows();
    logger.info({ count: unfinishedFlows.length }, 'Found unfinished flows');

    for (const flow of unfinishedFlows) {
      // Extract tracking params from flow metadata
      const params: FlowTrackingParams = (flow.metadata as FlowTrackingParams) || {
        evmBurnTxHash: flow.txHash || undefined,
      };

      // Enqueue polling job
      await queueManager.txPollingQueue.add(
        `flow-${flow.id}`,
        {
          flowId: flow.id,
          flowType: flow.flowType || 'deposit',
          params,
        },
        {
          jobId: `resume-${flow.id}-${Date.now()}`,
          delay: 1000, // Small delay to avoid overwhelming the system
        }
      );

      logger.debug({ flowId: flow.id }, 'Enqueued resume job for flow');
    }

    logger.info(
      { count: unfinishedFlows.length },
      'Finished resuming unfinished flows'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to resume unfinished flows');
    throw error;
  }
}

