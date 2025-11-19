import type { Job } from 'bullmq';
import type { AppLogger } from '../common/utils/logger.js';
import type { NobleForwardingService } from '../modules/noble-forwarding-tracker/service.js';
import type { AppConfig } from '../config/env.js';

export interface NobleForwardingCheckerJobData {
  // No data needed - job processes all pending registrations
}

export function createNobleForwardingCheckerProcessor(
  nobleForwardingService: NobleForwardingService,
  config: AppConfig,
  logger: AppLogger
) {
  return async (job: Job<NobleForwardingCheckerJobData>) => {
    logger.info({ jobId: job.id }, 'Processing Noble forwarding checker job');

    try {
      const result = await nobleForwardingService.processPendingRegistrations({
        minUusdc: config.nobleRegMinUusdc,
        gasLimit: config.nobleRegGas,
        feeUusdc: config.nobleRegFeeUusdc.toString(),
        staleMs: config.nobleRegStaleMs
      });

      logger.info(
        {
          jobId: job.id,
          processed: result.processed,
          registered: result.registered,
          failed: result.failed,
          stale: result.stale
        },
        'Noble forwarding checker job completed'
      );

      return {
        success: true,
        ...result
      };
    } catch (error) {
      logger.error(
        { err: error, jobId: job.id },
        'Noble forwarding checker job failed'
      );
      throw error;
    }
  };
}

